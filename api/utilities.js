const wp = require('./provider');

const applyParams = (call, params) => Object.entries(params).reduce((acc, param) => acc.param(...param), call);

const parseMetaField = (post, field, cb) => {
    if (typeof post === 'object'
    && post !== null
    && typeof post.meta === 'object'
    && post.meta !== null
    && post.meta[field]) {
        post.meta[field] = cb(post.meta[field]);
    }
}

const resolveFeaturedMedia = async (post) => {
    if (!post.featured_media) return;
    post.featured_media = await wp.media().id(post.featured_media).get();
}

const loadAll = async (cb) => {
    let accumulator = [];
    let page = 1;
    while(true) {
        try {
            const data = await cb(page);
            if (data.length === 0) throw { code: 'rest_post_invalid_page_number' };
            accumulator.push(...data);
            page++;
        } catch (e) {
            if (e.code === 'rest_post_invalid_page_number') {
                break;
            }
            throw e;
        }
    }
    return accumulator;
}

module.exports = {
    applyParams,
    parseMetaField,
    resolveFeaturedMedia,
    loadAll
}