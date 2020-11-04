const { JSDOM } = require('jsdom');
const wp = require('./provider');
const { searchBySlug, searchById } = require('./users');
const { applyParams, resolveFeaturedMedia, parseMetaField } = require('./utilities');

const { document } = (new JSDOM(``)).window;

// A bunch of nasty string parsing to get some structured data from the WP content
const parseReview = async (html) => {
    const container = document.createElement('div');
    container.innerHTML = html;
    const d97case = container.querySelector('._d97');
    if (d97case) {
        d97case.outerHTML = d97case.innerHTML;
    }
    const reviewerName = container.querySelector('h3').textContent.trim();
    const reviewer = reviewerName; // await searchBySlug(reviewerName);
    const body = container.innerHTML.replace(/^.+?<\/h3>(.+?)<span class="score".+?$/s, "$1").replace(/tabindex="\d"/g, '').trim();
    const scoreWrap = container.querySelector('span.score');
    const scoreJson = scoreWrap.getAttribute('data-score');
    let score = {};
    try {
        score = JSON.parse(scoreJson);
    } catch { }
    const trackWrap = scoreWrap.nextElementSibling;
    trackWrap.removeChild(trackWrap.querySelector('strong'));
    const tracks = trackWrap.innerHTML.split('<br>').map(track => track.replace(/\s*&nbsp;\s*|\n/g, ''));
    return {
        reviewer,
        body,
        score,
        tracks,
    };
}

const parseColours = (colours) => {
    const coloursSplit = colours.split(';');
    return {
        primary: coloursSplit[0],
        secondary: coloursSplit[1],
        tertiary: coloursSplit[2],
    };
};

const parseTracks = (tracks) => tracks.split(';').map(track => track.trim());

const parseScore = (score) => {
    const [given, possible] = score.split('/').map(i => parseInt(i));
    return {
        given,
        possible,
        fraction: given/possible,
    };
};

const processPost = async (post) => {
    post.withErrors = false;
    post.date = new Date(post.date);
    post.date_gmt = new Date(post.date_gmt);
    post.modified = new Date(post.modified);
    post.modified_gmt = new Date(post.modified_gmt);
    post.author = await searchById(post.author, 'id');
    resolveFeaturedMedia(post);
    return post;
}

const processReview = async (post) => {
    processPost(post);
    const reviews = post.content.rendered.split('<hr />');
    post.reviews = [];
    for (const review of reviews) {
        try {
            post.reviews.push(await parseReview(review));
        } catch(e) {
            console.error('Issue parsing review:', e.message);
            post.withErrors = true;
        }
    }
    parseMetaField(post, 'Post Colours', parseColours);
    parseMetaField(post, 'Overall Score', parseScore);
    parseMetaField(post, 'Essential Tracks', parseTracks);
    parseMetaField(post, 'Favourite Tracks', parseTracks);
    return post;
}

const processPosts = async (cb) => Promise.all((await cb).map(processPost));

const processReviews = async (cb) => Promise.all((await cb).map(processReview));

const getRawPosts = () => wp.posts();

const getRawReviews = (params = {}) => applyParams(getRawPosts().categories(2), params);

const getRawArticles = (params = {}) => applyParams(getRawPosts().excludeCategories(2), params);

const getPosts = (params = {}) => applyParams(getRawPosts(), params).then(posts => {
    return Promise.all(posts.map(async (post) => {
        if (post.categories.includes(2)) {
            return processReview(post);
        }
        return processPost(post);
    }));
});

const getArticleBySlug = (slug) => processPosts(getRawArticles().slug(slug));

const getArticles = (params) => processPosts(getRawArticles(params).get());

const getReviewBySlug = (slug) => processReviews(getRawReviews().slug(slug));

const getReviews = (params) => processReviews(getRawReviews(params).get());

module.exports = {
    getPosts,
    getArticleBySlug,
    getArticles,
    getReviewBySlug,
    getReviews,
}
