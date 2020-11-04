const wp = require('./provider');

const users = [];

const get = async () => {
    if (users.length === 0) {
        users.push(...(await wp.users().perPage(100).get()));
    }
    return users;
}

const searchByIdWith = (users, query) => users.find(({ id }) => query === id);

// TODO: Improve this hack
const searchBySlugWith = (users, query) => users.find(({ slug }) => query.toLowerCase().replace('é', 'e') === slug);

const searchById = async (query) => searchByIdWith(await get(), query);

const searchBySlug = async (query) => searchBySlugWith(await get(), query);

module.exports = {
    get,
    searchByIdWith,
    searchBySlugWith,
    searchById,
    searchBySlug,
}