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

const mdConverter = new showdown.Converter({ extensions: [footnoteRefExtension, pullquoteExtension] });
const toHTML = (md) => resolveLocalUrls(mdConverter.makeHtml(md.replace(/([^\n])\n([^\n])/g, '$1\n\n$2')));

let userInputBase, userOutputBase, userSearchBase, userSearchOptions;
const configPath = process.argv[1];
if (typeof configPath === 'string' && configPath.length > 0) {
    try {
        const configFile = nodePath.resolve(__dirname, process.argv[1], { encoding: 'utf8' });
        const configData = fs.readFileSync(configFile);
        ({
            data: userInputBase,
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
const searchBase = userSearchBase || './functions/search';
const searchOptionsPath = userSearchOptions || `${searchBase}/searchOptions.json`;
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

let imageConfig = {};
const imagesSizes = [];
const imageMax = {};
const data = {};

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
            const sizePath = `${imagesBase}${outputImagePath}${outputImageFile}-${name}${extension}`;
            sizeObj[name] = process.env.API_URL + sizePath;
            return image.clone()
                .resize(w, h, { withoutEnlargement: true })
                .toFile(outputBase + sizePath);
        }),
    );
    return sizeObj;
}

const resolveLocalUrls = async (html) => {
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
                    srcset += `${joiner}${process.env.API_URL}${imagesBase}/${path}${file}-${size}-original${extension} ${Math.min(width, max.w)}w`;
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
    return html.replace(localImage, `$1${process.env.API_URL}/images/$2"`)
        .replace(localLink, `$1${process.env.SITE_URL}/$3"`);
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
                    yaml.review = await toHTML(yaml.review);
                }
                if ('content' in yaml) {
                    yaml.content = await toHTML(yaml.content);
                }
                if ('body' in yaml) {
                    yaml.body = await toHTML(yaml.body);
                }
                return yaml;
            case 'string':
                return await toHTML(contentStr);
        }
        return await toHTML(contentStr);
        // if (parsed) return parsed;
        // return contentStr;
    }));
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
            if (typeof author !== 'object') {
                delete obj.author;
                return;
            }
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
        tags: postTags.map(tag => ({ title: tag, route: `/tags/${tag}` })),
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
        await fs.promises.writeFile(path, feed.xml());
    };
    const addItems = (posts, feed) => posts.slice(0, POST_LIMIT).forEach(post => feed.item({
        title: post.metadata.title,
        description: post.metadata.summary || post.metadata.blurb,
        url: `${process.env.SITE_URL}/${post.metadata.type}/${post.metadata.slug}`,
        categories: post.metadata.tags,
        date: new Date(post.metadata.created).toISOString(),
        custom_elements: [
            { "dc:creator": post.metadata.author ? post.metadata.author.name : 'Audioxide' },
        ],
    }));
    const now = new Date().toISOString();
    const defaultOptions = {
        title: "Audioxide",
        description: "Independent music webzine. Publishes reviews, articles, interviews, and other oddities.",
        feed_url: `${process.env.SITE_URL}/feed/`,
        site_url: process.env.SITE_URL,
        language: "en-GB",
        pubDate: now,
        ttl: 1440,
        custom_namespaces: {
            sy: "http://purl.org/rss/1.0/modules/syndication/",
            dc: "http://purl.org/dc/elements/1.1/",
        },
        custom_elements: [
            { "sy:updatePeriod": "daily" },
            { "sy:updateFrequency": 1 },
            { "lastBuildDate": now }
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
            feed_url: `${defaultOptions.feed_url}/${type}/`,
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
            feed_url: `${defaultOptions.feed_url}/tags/${tag}/`,
            pubDate: new Date(posts[0].metadata.created).toISOString(),
        });
        addItems(posts, feed);
        writers.push(writeFeed(`tags/${tag}/index`, feed));
    });
    return Promise.all(writers);
};

const generateResponse = (obj, name) => {
    return fs.promises.writeFile(`${outputBase}${name}.json`, JSON.stringify(obj));
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
        // Author resolution
        resolveAuthor(post.metadata);
        post.content.forEach(item => {
            if (typeof item === 'object' && item !== null) {
                resolveAuthor(item);
            }
        });

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

    await Promise.all(['', postBase, indexedPostsBase, pageBase, imagesBase, tagsBase, feedBase].map(dir => {
        const checkPath = outputBase + dir;
        if (!fs.existsSync(checkPath)) {
            return fs.promises.mkdir(checkPath, { recursive: true });
        }
        return Promise.resolve();
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
            image: metadata.featuredimage['small-square'],
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
};

init();