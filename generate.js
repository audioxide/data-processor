#!/usr/bin/env node

const fs = require('fs');
const nodePath = require('path');
const { JSDOM } = require('jsdom');
const RSS = require('rss-generator');
const YAML = require('yaml');
const showdown = require('showdown');
const sharp = require('sharp');
const FlexSearch = require('flexsearch');
const { deburr, set, startCase, uniqueId } = require('lodash');
const ComponentBundler = require('./buildComponents');

const footnoteRefExtension = () => [
    {
        type: 'lang',
        filter: (text) => {
            let newText = text;
            const matches = newText.match(/^\[\^([^\]]+?)\]: (.+?)$/gm);
            if (Array.isArray(matches)) {
                matches.forEach(match => {
                    const [fullMatch, symbol, fnText] = match.match(/^\[\^([^\]]+?)\]: (.+?)$/m);
                    const id = uniqueId('footnote-');
                    const refId = `${id}-ref`;
                    newText = newText.replace(fullMatch, `<p class="footnote" id="${id}" role="doc-endnote"><sup>${symbol}</sup> ${fnText} <a href="#${refId}" role="doc-backlink">↩</a></p>`);
                    const refStr = `[^${symbol}]`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // escape any characters with special meaning
                    const refs = newText.match(new RegExp(refStr, 'g'));
                    if (Array.isArray(refs)) {
                        refs.forEach((ref, pos) => {
                            const uid = pos === 0 ? refId : uniqueId(refId);
                            newText = newText.replace(ref, `<sup id="${uid}" role="doc-noteref"><a href="#${id}">${symbol}</a></sup>`)
                        });
                    }
                })
            }
            return newText;
        },
    },
];

const pullquoteExtension = () => [
    {
        type: 'lang',
        regex: /\[([^\]]+)\]\(\+\)/g,
        replace: '<span data-pullquote="$1">$1</span>'
    },
];

const mdConverter = new showdown.Converter({ tables: true, extensions: [footnoteRefExtension, pullquoteExtension] });
const toHTML = async (md, metadata) => {
    // The markdown converter needs more spacing than our content naturally has
    // There's an exception for markdown tables, which need to be on sequential lines
    const spaceHackedMd = md.replace(/([^\n|])\n([^\n|])/g, '$1\n\n$2');
    const rawHTML = mdConverter.makeHtml(spaceHackedMd);
    // Resolve internal, relative URLs to absolute URLs
    const withResolvedUrls = await resolveLocalUrls(rawHTML);
    const withContentAdapters = await runContentAdapters(withResolvedUrls, metadata);
    const matches = customComponentTagNames.filter(tag => withContentAdapters.indexOf('<' + tag) > -1);
    if (matches.length === 0) return withContentAdapters;
    const fragment = new JSDOM(withContentAdapters);
    const fragDoc = fragment.window.document;
    const tempWrapper = fragDoc.createElement('div');
    matches.forEach(tag => {
        const config = customComponents[tag];
        let found = false;
        fragDoc.querySelectorAll(tag).forEach(elm => {
            const props = {};
            for (const attribute of elm.attributes) {
                const { name, value } = attribute;
                props[name] = value;
                if (name.indexOf('-') > -1) {
                    const camelCase = name.split('-').map((str, ind) => ind > 0 ? str[0].toUpperCase() + str.substr(1) : str).join('');
                    props[camelCase] = value;
                }
            }
            tempWrapper.innerHTML = config.html(props).replace(/\n\s*?(?=\S)/g,'').trim();
            const parent = elm.parentElement;
            if (parent === fragDoc.body) {
                elm.after(tempWrapper.firstElementChild);
                elm.remove();
            } else {
                parent.after(tempWrapper.firstElementChild);
                parent.remove();
            }
            found = true;
        });
        if (found) {
            const { scripts, styles } = metadata.components;
            config.isDynamic && scripts.add(tag);
            config.hasStyles && styles.add(tag);
            usedCustomComponents.add(tag);
        }
    });
    return fragDoc.body.innerHTML;
};

let userInputBase, userComponentsBase, userOutputBase, userSearchBase, userSearchOptions;
const configPath = process.argv[2];
if (typeof configPath === 'string' && configPath.length > 0) {
    try {
        const configFile = nodePath.resolve(__dirname, process.argv[1], { encoding: 'utf8' });
        const configData = fs.readFileSync(configFile);
        ({
            data: userInputBase,
            components: userComponentsBase,
            output: userOutputBase,
            searchFunction: userSearchBase,
            searchOptions: userSearchOptions,
        } = JSON.parse(configData));
    } catch (e) {
        console.warn('Unable to parse config file.', e.message);
    }
}

const inputBase = userInputBase || './data';
const outputBase = userOutputBase || './dist';
const componentsBase = userComponentsBase || './components';
const searchBase = userSearchBase || './functions/search';
const searchOptionsPath = userSearchOptions || `${searchBase}/searchOptions.json`;
const overwriteImages = false;
const noImageGeneration = process.env.NO_IMAGES === 'true';
const postBase = '/posts';
const indexedPostsBase = '/posts/indexed';
const pageBase = '/pages';
const imagesBase = '/images';
const tagsBase = '/tags';
const feedBase = '/feed';
const segmentDetector = /(^|\r?\n?)---\r?\n/;
const segmentDivisor = /\r?\n---\r?\n/;
const localImage = /(?<=<img)([^>]+?src=")(?!http)([^"]+?)"/g;
const localLink = /(?<=<a )([^>]*?href=")(?!http)(?!mailto)(?!#)(\/{0,1})([^"]+?)"/g;

const API_URL = process.env.API_URL || 'http://localhost:8888';
const SITE_URL = process.env.SITE_URL || 'http://localhost:3000';
const IMAGES_CDN_URL = process.env.IMAGES_URL || API_URL + imagesBase;

let imageConfig = {};
const imagesSizes = [];
const imageMax = {};
const data = {};
const customComponents = {};
const customComponentTagNames = [];
const usedCustomComponents = new Set();

const getPathParts = filePath => {
    const [match, path, file, extension] = filePath.match(/^(.+?)([^/]+?)(\.[a-zA-Z]{1,4})$/);
    return { path, file, extension };
};

// Pull the image generation out
// Needs to apply to article images too
// When resolving images, add in srcset
const generateImages = async (originalPath) => {
    const sizeObj = {};
    const imagePath = `/${originalPath}`;
    const { path: outputImagePath, file: outputImageFile, extension } = getPathParts(imagePath);
    if (!fs.existsSync(outputBase + imagesBase + outputImagePath)) {
        await fs.promises.mkdir(outputBase + imagesBase + outputImagePath, { recursive: true });
    }
    const inputImageFilePath = inputBase + imagesBase + imagePath;
    if (!fs.existsSync(inputImageFilePath)) {
        throw Error(`Image "${inputImageFilePath}" could not be found.`);
    }
    const image = sharp(inputImageFilePath);
    const metadata = await image.metadata();
    imageMax[originalPath] = { w: metadata.width, h: metadata.height };
    await Promise.all(
        imagesSizes.map(({ name, w, h }) => {
            const sizePath = `${outputImagePath}${outputImageFile}-${name}${extension}`;
            const absSizePath = outputBase + imagesBase + sizePath;
            sizeObj[name] = IMAGES_CDN_URL + sizePath;
            if (noImageGeneration || (!overwriteImages && fs.existsSync(absSizePath))) {
                return Promise.resolve();
            }
            return image.clone()
                .resize(w, h, { withoutEnlargement: true })
                .toFile(absSizePath);
        }),
    );
    return sizeObj;
}

const resolveLocalUrls = async (html) => {
    const fragment = new JSDOM(html);
    const fragDoc = fragment.window.document;
    const images = fragDoc.querySelectorAll('img');
    const links = fragDoc.querySelectorAll('a');
    const sizes = Object.entries(imageConfig.sizes);
    if (images.length > 0) {
        await Promise.all(
            Array.from(images).map(async (image) => {
                const src = image.src;
                if (src.startsWith('http')) return;
                const picture = fragDoc.createElement('picture');
                const { dir, name, ext } = nodePath.parse(src);
                await generateImages(src);
                const max = imageMax[src];
                imageConfig.formats.forEach(format => {
                    const source = fragDoc.createElement('source');
                    const isOriginal = format === '[original]';
                    let srcset = '';
                    let i = 0;
                    let joiner = '';
                    const sourceExt = isOriginal ? ext : `.${format}`;
                    do {
                        const [size, width] = sizes[i];
                        srcset += `${joiner}${IMAGES_CDN_URL}/${dir}/${name}-${size}-original${sourceExt} ${Math.min(width, max.w)}w`;
                        joiner = ',\n';
                        i++;
                    } while (i < sizes.length && sizes[i - 1][1] < max.w);
                    source.srcset = srcset
                    if (!isOriginal) {
                        source.type = `image/${format}`;
                    }
                    picture.appendChild(source);
                });
                image.src = `${IMAGES_CDN_URL}/${src.replace(name, `${name}-medium-original`)}`;
                image.sizes = `(max-width: ${max.w}px) 100vw, ${max.w}px`;
                image.width = max.w;
                image.height = max.h;
                image.loading = 'lazy';
                image.insertAdjacentElement('afterend', picture);
                picture.appendChild(image);
            })
        );
    }
    links.forEach(link => {
        // Don't prefix absolute URLs, email addresses or anchors
        if (/^(http|mailto|#)/.test(link.href)) return;
        link.href = `${SITE_URL}/${link.href}`;
    });

    return fragDoc.body.innerHTML;
};

const resolveLocalUrlsOld = async (html) => {
    const images = html.match(localImage);
    if (Array.isArray(images)) {
        await Promise.all(
            images.map(async (image) => {
                const [match, src] = image.match(/src="([^"]+?)"/);
                const { path, file, extension } = getPathParts(src);
                await generateImages(src);
                const max = imageMax[src];
                const sizes = Object.entries(imageConfig.sizes);
                let srcset = '';
                let i = 0;
                let joiner = '';
                do {
                    const [size, width] = sizes[i];
                    srcset += `${joiner}${IMAGES_CDN_URL}/${path}${file}-${size}-original${extension} ${Math.min(width, max.w)}w`;
                    joiner = ',\n';
                    i++;
                } while (i < sizes.length && sizes[i - 1][1] < max.w);
                let imageWithAttributes = `${image.replace(file, `${file}-medium-original`)} srcset="${srcset}" sizes="(max-width: ${max.w}px) 100vw, ${max.w}px" loading="lazy"`;
                if (image.indexOf('width=') === -1 && image.indexOf('height=') === -1) {
                    imageWithAttributes += ` width="${max.w}" height="${max.h}"`;
                }

                html = html.replace(image, imageWithAttributes);
            }),
        );
    }
    return html.replace(localImage, `$1${IMAGES_CDN_URL}/$2"`)
        .replace(localLink, `$1${SITE_URL}/$3"`);
}

// TODO: Rewrite this to allow for configurable adaptation
const runContentAdapters = (html, metadata) => {
    if (metadata.type === 'listening-parties') {
        const fragment = new JSDOM(html);
        const speakers = [];
        fragment.window.document.querySelectorAll('h2 ~ p strong').forEach(elm => {
            const speaker = elm.textContent;
            const p = elm.parentElement;
            let index = speakers.indexOf(speaker);
            if (index === -1) {
                index = speakers.length;
                speakers.push(speaker);
            }
            p.innerHTML = speaker;
            p.classList.add('speaker-name');
            p.classList.add(`speaker-${index}`);
        });
        fragment.window.document.querySelectorAll('p.speaker-name').forEach(elm => {
            const speakerClass = Array.from(elm.classList.values()).find(i => i.match(/speaker-\d/));
            let message = elm.nextElementSibling;
            while (message && message.tagName === 'P' && !message.classList.contains('speaker-name')) {
                message.classList.add('message');
                message.classList.add(speakerClass);
                message = message.nextElementSibling;
            }
        });
        html = fragment.window.document.body.innerHTML;
    }
    return html;
}

const processContentFile = async (path, metadataYAML, contentSegments) => {
    // We infer some information from the filename
    const parsedPath = nodePath.parse(path);
    const metadata = {
        slug: parsedPath.name,
    };
    const postTitle = path.match(/(\d{4})(\d{2})(\d{2})-([^-]+?)-(.+?)\.md$/);
    if (postTitle) {
        const [match, year, month, day, type, slug] = postTitle;
        date = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
        Object.assign(metadata, {
            slug,
            type,
            created: date,
        });
    }
    metadata.title = startCase(metadata.slug);
    let isGeneratedTitle = true;
    let content = [];
    try {
        const parsed = YAML.parse(metadataYAML);
        if ('title' in parsed) {
            isGeneratedTitle = false;
        }
        // Anything parsed from the first segment as YAML will overwrite and add to the defaults
        Object.assign(metadata, parsed);
    } catch {}
    if (isGeneratedTitle && ('album' in metadata) && ('artist' in metadata)) {
        // Special formatting for posts with an album and artist and no title
        metadata.title = `${metadata.album} // ${metadata.artist}`;
    }
    if (!('modified' in metadata) && 'created' in metadata) {
        metadata.modified = metadata.created;
    }
    if (!('blurb' in metadata) && 'summary' in metadata) {
        metadata.blurb = metadata.summary;
    }
    if ('featuredimage' in metadata) {
        metadata.featuredimage = await generateImages(metadata.featuredimage);
    }
    // For each further segment, attempt to parse it as YAML, Markdown or just return plain text
    metadata.components = {
        scripts: new Set(),
        styles: new Set(),
    };
    content = await Promise.all(contentSegments.map(async (contentStr) => {
        let yaml;
        try {
            yaml = YAML.parse(contentStr);
        } catch {}
        switch(typeof yaml) {
            case 'object':
                if (yaml === null) break;
                // Reviews and content can both contain markdown
                if ('review' in yaml) {
                    yaml.review = await toHTML(yaml.review, metadata);
                }
                if ('content' in yaml) {
                    yaml.content = await toHTML(yaml.content, metadata);
                }
                if ('body' in yaml) {
                    yaml.body = await toHTML(yaml.body, metadata);
                }
                return yaml;
            case 'string':
                return await toHTML(contentStr, metadata);
        }
        return await toHTML(contentStr, metadata);
        // if (parsed) return parsed;
        // return contentStr;
    }));
    metadata.components.scripts = Array.from(metadata.components.scripts);
    metadata.components.styles = Array.from(metadata.components.styles);
    if (!('author' in metadata) && Array.isArray(content)) {
        // Generate author from content if possible
        const authors = content.reduce((acc, block) => {
            if (typeof block === 'object' && 'author' in block) {
                acc.push(block.author);
            }
            return acc;
        }, []);
        if (authors.length > 0) {
            metadata.author = authors;
        }
    }
    return { metadata, content };
};

const parseFile = async (path) => {
    const fileData = await fs.promises.readFile(inputBase + path, { encoding: 'utf8' });
    // The file has to have content, and it has to have separators
    if (fileData.length === 0
        || !fileData.match(segmentDetector)) return;
    // Split the segments to get legal YAML
    const segments = fileData.split(segmentDivisor);
    // Metadata is always first, the rest is content
    const [metadataYAML, ...contentSegments] = segments;
    // Each file should at least contain some metadata
    if (!metadataYAML) return;
    let item;
    if (contentSegments.length > 0) {
        // We're reading a content file, they require further processing
        item = await processContentFile(path, metadataYAML, contentSegments);
    }
    if (!item) {
        item = YAML.parse(metadataYAML);
    }
    set(data, path.substr(1, path.length - 4).replace(/\//g, '.'), item);
};

const parseDir = async (path) => {
    const files = await fs.promises.readdir(inputBase + path);
    await Promise.all(files.map(async file => {
        const filePath = `${path}/${file}`;
        const stat = await fs.promises.stat(inputBase + filePath);
        if (stat.isDirectory()) {
            await parseDir(filePath);
        } else if (stat.isFile()) {
            await parseFile(filePath);
        }
    }));
};

const loadComponents = async () => {
    const componentDirectories = await fs.promises.readdir(componentsBase);
    await Promise.all(componentDirectories.map(async dir => {
        const path = nodePath.resolve(componentsBase, dir);
        const configPath = nodePath.resolve(path + '/config.js');
        const stat = await fs.promises.stat(path);
        if (stat.isDirectory() && fs.existsSync(configPath)) {
            const config = require(configPath);
            customComponents[config.tagName] = config;
            config.root = path;
            config.isDynamic = fs.existsSync(ComponentBundler.getComponentFile(path));
            config.hasStyles = ComponentBundler.styleEntrypoints.some(filename => fs.existsSync(nodePath.join(path, filename)));
        }
    }));
    customComponentTagNames.push(...Object.keys(customComponents));
};

const resolveImageSizes = ({ variations, sizes }) => Object.entries(sizes)
    .forEach(([label, w]) => Object.entries(variations)
        .forEach(([variation, ratio]) => imagesSizes.push({
            name: `${label}-${variation}`,
            h: Number.isFinite(ratio) ? w / ratio : undefined,
            w,
        })));

const resolveAuthor = (obj) => {
    const resolveSingle = (ref) => {
        const author = ref.toLowerCase();
        const deburred = deburr(author);
        if (author in data.authors) {
            return { ...data.authors[author], slug: author };
        }
        if (deburred in data.authors) {
            return { ...data.authors[deburred], slug: deburred };
        }
        let authorObj;
        Object.entries(data.authors).some(([key, value]) => {
            if (deburr(key) === deburred) {
                authorObj = { ...value, slug: key };
                return true;
            }
            return false;
        });
        if (typeof authorObj === 'undefined') {
            throw Error(`Author reference '${ref}' could not be resolved.`);
        }
        return authorObj;
    }
    switch(typeof obj.author) {
        case 'object':
            if (Array.isArray(obj.author)) {
                // An array of multiple authors, resolve any string values
                const authors = obj.author
                    .filter(ref => typeof ref === 'string')
                    .map(ref => resolveSingle(ref))
                    .filter(obj => typeof obj === 'object');
                if (authors.length === 0) {
                    delete obj.author;
                    return;
                }
                obj.author = {
                    name: authors.reduce((acc, val, ind, arr) => {
                        let joiner = ', ';
                        if (ind === 0) {
                            joiner = '';
                        } else if (ind === arr.length - 1) {
                            joiner = ' & ';
                        }
                        return acc.concat(joiner, val.name);
                    }, ''),
                    authors,
                }
                return;
            }
            // Maybe this has already been resolved? Unlikely; no-op
            return;
        case 'string':
            // Single author, original use case
            // TODO: Should we return an array here too for consistency?
            const author = resolveSingle(obj.author);
            obj.author = {
                name: author.name,
                authors: [author],
            };
            return;
        default:
            // No-op, we can't resolve this
    }
}

const generateSearchData = async (posts, postTags, postTypes) => {
    const searchOptions = await fs.promises.readFile(searchOptionsPath, { encoding: 'utf8' });
    const index = new FlexSearch(JSON.parse(searchOptions));
    const taxonomies = {
        tags: postTags.map(tag => ({ title: tag, route: `/tags/${tag.replace(/ /g, '-')}` })),
        types: postTypes.map(type => ({ title: type, route: `/${type}` })),
    };
    posts.forEach(post => {
        const { metadata: { type, slug, title, tags }, content } = post;
        index.add({
            route: `/${type}/${slug}`,
            title,
            type,
            slug,
            tagStr: tags.join(" "),
            content: content
                .map(block => typeof block === "string" ? block : block.review || block.content || block.body || "")
                .map(html => new JSDOM(html).window.document.body.textContent)
                .join(" "),
        });
    });
    await Promise.all([
        fs.promises.writeFile(`${searchBase}/searchIndex.json`, index.export()),
        fs.promises.writeFile(`${searchBase}/taxonomies.json`, JSON.stringify(taxonomies)),
    ]);
};

const generateRss = (latest, types, tags) => {
    const POST_LIMIT = 10;
    const writers = [];
    const writeFeed = async (filename, feed) => {
        // We use the HTML extension to abuse Netlify's URL normalisation
        const path = `${outputBase}${feedBase}/${filename}.html`;
        const dir = nodePath.dirname(path);
        if (!fs.existsSync(dir)) {
            await fs.promises.mkdir(dir, { recursive: true });
        }
        // Strip out lastBuildDate to stop unnecessary cache misses
        await fs.promises.writeFile(path, feed.xml().replace(/<lastBuildDate>[^<]+?<\/lastBuildDate>/g, ''));
    };
    const addItems = (posts, feed) => posts.slice(0, POST_LIMIT).forEach(post => feed.item({
        title: post.metadata.title,
        description: post.metadata.summary || post.metadata.blurb,
        url: `${SITE_URL}/${post.metadata.type}/${post.metadata.slug}`,
        categories: post.metadata.tags,
        date: new Date(post.metadata.created).toISOString(),
        custom_elements: [
            { "dc:creator": post.metadata.author ? post.metadata.author.name : 'Audioxide' },
        ],
    }));
    const defaultOptions = {
        title: "Audioxide",
        description: "Independent music webzine. Publishes reviews, articles, interviews, and other oddities.",
        feed_url: `${SITE_URL}/feed/`,
        site_url: SITE_URL,
        language: "en-GB",
        ttl: 1440,
        // pubDate must be added in each case
        custom_namespaces: {
            sy: "http://purl.org/rss/1.0/modules/syndication/",
            dc: "http://purl.org/dc/elements/1.1/",
        },
        custom_elements: [
            { "sy:updatePeriod": "daily" },
            { "sy:updateFrequency": 1 }
        ]
    };
    // Default RSS is latest posts
    const latestFeed = new RSS({
        ...defaultOptions,
        pubDate: new Date(latest[0].metadata.created).toISOString(),
    });
    addItems(latest, latestFeed);
    writers.push(writeFeed('index', latestFeed));

    // Top level post type feeds
    Object.entries(types).forEach(([type, posts]) => {
        const feed = new RSS({
            ...defaultOptions,
            title: `${startCase(type)} // Audioxide`,
            feed_url: `${defaultOptions.feed_url}${type}/`,
            pubDate: new Date(posts[0].metadata.created).toISOString(),
        });
        addItems(posts, feed);
        writers.push(writeFeed(`${type}/index`, feed));
    });

    // Tag group feeds
    Object.entries(tags).forEach(([tag, posts]) => {
        const feed = new RSS({
            ...defaultOptions,
            title: `Posts tagged "${tag}" // Audioxide`,
            feed_url: `${defaultOptions.feed_url}tags/${tag}/`,
            pubDate: new Date(posts[0].metadata.created).toISOString(),
        });
        addItems(posts, feed);
        writers.push(writeFeed(`tags/${tag}/index`, feed));
    });
    return Promise.all(writers);
};

const generateResponse = (obj, name) => {
    return fs.promises.writeFile(`${outputBase}/${name}.json`, JSON.stringify(obj));
};

const init = async () => {
    // Load image sizes
    imageConfig = JSON.parse(
        await fs.promises.readFile(
            `${inputBase}${imagesBase}/sizes.json`,
            { encoding: 'utf8' },
        ),
    );
    resolveImageSizes(imageConfig);

    await loadComponents();

    // Parse data
    await parseDir('');

    const postsArr = Object.values(data.posts).sort((a, b) => {
        const aDate = new Date(a.metadata.created);
        const bDate = new Date(b.metadata.created);
        return ((aDate < bDate) * 2) - 1;
    });

    // Group posts by type
    const typeGrouping = {};
    // Group posts by tag
    const tagGrouping = {};
    for (let id = 0; id < postsArr.length; id++) {
        const post = postsArr[id];
        try {
            // Author resolution
            resolveAuthor(post.metadata);
            post.content.forEach(item => {
                if (typeof item === 'object' && item !== null) {
                    resolveAuthor(item);
                }
            });
        } catch (e) {
            throw Error(`[Author resolution] ${post.metadata.slug}: ${e}`);
        }

        // Add id to post
        post.metadata.id = postsArr.length - 1 - id;

        // Type grouping
        const type = post.metadata.type;
        if (!(type in typeGrouping)) {
            typeGrouping[type] = [];
        }
        typeGrouping[type].push(post);

        // Tag aggregation
        const postTags = post.metadata.tags;
        if (Array.isArray(postTags)) {
            postTags.forEach(tag => {
                if (!(tag in tagGrouping)) {
                    tagGrouping[tag] = [];
                }
                tagGrouping[tag].push(post);
            })
        }
    }

    // Generate recommendations
    const RELATED_POSTS = 4;
    postsArr.forEach(targetPost => {
        const postTags = targetPost.metadata.tags;
        if (!Array.isArray(postTags)) return;
        const matchingTagPostsSet = new Set();
        postTags.forEach(tag => {
            const postGroup = tagGrouping[tag];
            postGroup.forEach(post => matchingTagPostsSet.add(post));
        });
        matchingTagPostsSet.delete(targetPost);
        const matchingTagPosts = Array.from(matchingTagPostsSet.values());
        const matchTagCount = (tags) => tags.filter(tag => postTags.includes(tag)).length;
        matchingTagPosts.sort((a, b) => {
            const matchingTagsA = matchTagCount(a.metadata.tags);
            const matchingTagsB = matchTagCount(b.metadata.tags);
            return matchingTagsA === matchingTagsB ? 0 : ((matchingTagsA < matchingTagsB) * 2) - 1;
        });
        // Top up recommendations with latest posts of the same type...
        if (matchingTagPosts.length < RELATED_POSTS) {
            typeGrouping[targetPost.metadata.type].every(post => {
                if (!matchingTagPosts.includes(post) && post !== targetPost) matchingTagPosts.push(post);
                return matchingTagPosts.length < RELATED_POSTS;
            });
        }
        // ...if that's not enough top up recommendations with any latest post
        if (matchingTagPosts.length < RELATED_POSTS) {
            postsArr.every(post => {
                if (!matchingTagPosts.includes(post) && post !== targetPost) matchingTagPosts.push(post);
                return matchingTagPosts.length < RELATED_POSTS;
            });
        }
        targetPost.related = matchingTagPosts.slice(0, RELATED_POSTS).map(({ metadata }) => ({ metadata }));
    });

    await Promise.all(['', postBase, indexedPostsBase, pageBase, imagesBase, tagsBase, feedBase, componentsBase].map(dir => {
        const checkPath = nodePath.join(outputBase, dir);
        if (!fs.existsSync(checkPath)) {
            return fs.promises.mkdir(checkPath, { recursive: true });
        }
        return Promise.resolve();
    }));

    await Promise.all(Array.from(usedCustomComponents).map(async tag => {
        const config = customComponents[tag];
        const bundler = new ComponentBundler(config.root);

        const outputDir = nodePath.join(outputBase, componentsBase, tag);
        if (!fs.existsSync(outputDir)) {
            await fs.promises.mkdir(outputDir);
        }

        ComponentBundler.styleEntrypoints.forEach(filename => {
            const styleFilePath = nodePath.join(config.root, filename);
            if (fs.existsSync(styleFilePath)) {
                bundler.addEntryPoint(styleFilePath);
            }
        });

        await bundler.bundle(outputDir);
    }));

    await Promise.all([
        generateSearchData(postsArr, Object.keys(tagGrouping), Object.keys(typeGrouping)),
        generateRss(postsArr, typeGrouping, tagGrouping),
        ...Object.entries(typeGrouping).map(([type, post]) => generateResponse(post.map(post => ({ metadata: post.metadata })), type)),
        generateResponse(Object.entries(typeGrouping).reduce((acc, [type, posts]) => Object.assign(acc, { [type]: posts.slice(0, 9).map(post => ({ metadata: post.metadata })) }), {}), 'latest'),
        ...Object.entries(typeGrouping).map(([type, posts]) => Promise.all(posts.map(post => generateResponse(post, `posts/${type}-${post.metadata.slug}`)))),
        ...postsArr.map(post => generateResponse(post, `posts/indexed/${post.metadata.id}`)),
        generateResponse(data.authors, 'authors'),
        ...Object.values(data.pages).map(page => generateResponse(page, `pages/${page.metadata.slug}`)),
        generateResponse(Object.keys(tagGrouping), 'tags'),
        ...Object.entries(tagGrouping).map(([tag, post]) => generateResponse(post.map(post => ({ metadata: post.metadata })), `tags/${tag}`)),
        generateResponse(typeGrouping.reviews.slice(0, 11).map(({ metadata }) => ({
            image: metadata.featuredimage['xsmall-square'],
            score: metadata.totalscore.given,
            artist: metadata.artist,
            album: metadata.album,
            slug: metadata.slug,
        })), 'albumbanner'),
        generateResponse({
            pages: Object.values(data.pages).map(page => page.metadata.slug),
            postTypes: Object.keys(typeGrouping),
            postTotal: postsArr.length,
        }, 'types'),
    ]);

    // TODO: Run component pre-render/generation steps
};

init().catch(e => {
    console.error(e);
    process.exit(1);
});