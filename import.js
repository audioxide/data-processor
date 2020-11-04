const fs = require('fs');
const { JSDOM } = require('jsdom');
const YAML = require('yaml');
const showdown = require('showdown');
const wp = require('./api/provider');
const { getPosts, getReviews } = require('./api/posts');
const { loadAll } = require('./api/utilities');

const { window } = new JSDOM('');

const mdConverter = new showdown.Converter();

// Import all posts
// Check if posts have characteristics of a review
// Attempt to process it as a review
// Take the metadata and, if available, review data and store it into a multi-yaml style file
// Post data is always last and is treated purely as markdown
// Store as a post, everything goes in a single folder
// Store all users available

// TODO retain date modified etc  maybe in title?

const getMarkdown = html => mdConverter.makeMarkdown(
    html.replace(/<span[^?]+?>/g, '<p>')
        .replace(/<\/span>/g, '</p>'), window.document)
        .replace(/---/g, '------')
        .replace(/\n{2,3}/g, '\n').trim();

const main = async () => {
    console.log('Starting import...');
    let posts;
    try {
        posts = await loadAll(page => getPosts({ per_page: 100, page}).then(r => {
            console.log(`Loaded post ${((page - 1) * 100) + 1} - ${page * 100}`);
            return r;
        }));
    } catch (e) {
        console.error('Failed to pull posts: ', e.message);
        console.log('Aborting import');
        return;
    }
    console.log(`Posts received. Found ${posts.length}`);
    const [tags, categories] = await Promise.all([
        loadAll(page => wp.tags().perPage(100).page(page)),
        loadAll(page => wp.categories().perPage(100).page(page)),
    ]);
    console.log(`${tags.length} tags found, ${categories.length} categories found`);
    fs.mkdirSync('./data/posts', { recursive: true });
    for (const post of posts) {
        let output = '---\n';
        const meta = {
            created: new Date(post.date_gmt).toISOString(),
            modified: new Date(post.modified_gmt).toISOString(),
            slug: post.slug,
            type: 'articles',
            tags: post.tags.map(tag => tags.find(({id}) => tag === id).name),
        };
        if (post.featured_media.source_url) {
            meta.featuredimage = post.featured_media.source_url.replace('https://audioxide.com/wp-content/uploads/', '');
        }
        if (post.categories.length > 0) {
            const category = categories.find(({ id }) => id === post.categories[0]);
            if (category) {
                meta.type = category.slug;
            }
        }
        if ('reviews' in post) {
            output += YAML.stringify({
                ...meta,
                artist: post.meta['Artist Name'],
                album: post.meta['Album Name'],
                essentialtracks: post.meta['Essential Tracks'],
                favouritetracks: post.meta['Favourite Tracks'],
                totalscore: post.meta['Overall Score'],
                colours: Object.values(post.meta['Post Colours']),
                pullquote: post.meta['Pull quote'].trim(),
                summary: post.meta['Summary'].trim(),
                week: parseInt(post.meta['Week Number']),
            });
            for (const review of post.reviews) {
                output += '---\n';
                output += YAML.stringify({
                    author: review.reviewer,
                    review: getMarkdown(review.body),
                    tracks: review.tracks,
                    score: review.score,
                });
            }
        } else {
            output += YAML.stringify({
                ...meta,
                title: post.title.rendered,
                author: post.author.slug,
            });
            output += '---\n';
            output += getMarkdown(post.content.rendered);
        }
        const createdDate = new Date(meta.created);
        const filePrefix = `${createdDate.getUTCFullYear()}${createdDate.getUTCMonth().toString().padStart(2, '0')}${createdDate.getUTCDate().toString().padStart(2, '0')}`;
        const filename = `${filePrefix}-${meta.type}-${meta.slug}.md`;
        if (post.withErrors) {
            console.log(`Parsing encountered errors with ${filename} ${post.link}`);
        }
        fs.writeFileSync(`./data/posts/${filename}`, output);
    }
    console.log(`There are ${posts.filter(i => i.withErrors).length} posts with errors`);
}

main();

/* const test = async () => {
    const [tags, categories] = await Promise.all([
        wp.tags(),
        wp.categories(),
    ]);
    console.log(tags);
}
test(); */