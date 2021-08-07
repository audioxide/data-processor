#!/usr/bin/env node

const ImageKit = require("imagekit");
const fs = require('fs/promises');
const nodePath = require('path');

const {
    IMAGEKIT_PUBKEY,
    IMAGEKIT_PRIVKEY,
    IMAGEKIT_URL
} = process.env;

const client = new ImageKit({
    publicKey: IMAGEKIT_PUBKEY,
    privateKey: IMAGEKIT_PRIVKEY,
    urlEndpoint: IMAGEKIT_URL
});

const inputBase = './data/images';
const parseDir = async (path) => {
    const files = await fs.readdir(inputBase + path);
    await Promise.all(files.map(async file => {
        const filePath = `${path}/${file}`;
        const stat = await fs.stat(inputBase + filePath);
        if (stat.isDirectory()) {
            await parseDir(filePath);
        } else if (stat.isFile()) {
            await processFile(filePath);
        }
    }));
};

const remoteFiles = [];
const processFile = async (path) => {
    if (remoteFiles.includes(path)) return; // Image does not need processing
    const { dir, base, ext } = nodePath.parse(path);
    if (!['.jpg', '.jpeg', '.png'].includes(ext)) return;
    await client.upload({
        useUniqueFileName: false,
        folder: dir,
        fileName: base,
        file: (await fs.readFile(inputBase + path)).toString('base64'),
    });
    console.log(`Uploaded ${path}`);
};

(async () => {
    remoteFiles.push(...(await client.listFiles()).map(file => file.filePath));
    await parseDir('');
})()