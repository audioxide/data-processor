const {
    Worker, isMainThread, parentPort, workerData
} = require('worker_threads');
const { S3Client, ListBucketsCommand, PutObjectCommand, ListObjectsV2Command } = require("@aws-sdk/client-s3");
const fs = require('fs/promises');
const nodePath = require('path');
const crypto = require('crypto');
const sharp = require('sharp');

const formatOptions = {
    'avif': {
        quality: 30,
        speed: 2,
    },
    'webp': {
        quality: 30,
    },
    '[original]': {
        progressive: true,
    }
};

const { imagesSizes, path, inputBase } = workerData;

(async () => {
    const { dir, name: filename, ext } = nodePath.parse(path);
    const image = sharp(inputBase + path);
    await Promise.all(
        imagesSizes.map(async ({ name: sizename, w, h, format }) => {
            // TODO: Rework this so it goes into a temp directory
            // TODO: Ensure just setting the extension correctly formats
            const fileExt = format === '[original]' ? ext.substr(1) : format;
            const fileKey = `${dir.substr(1)}/${filename}-${sizename}.${fileExt}`;
            // sizeObj[sizename] = API_URL + fileKey;
            // console.log(fileKey);
            console.log('Starting to process', fileKey);
            const buffer = await image.clone()
                .resize(w, h, { withoutEnlargement: true })
                .toFormat(fileExt, formatOptions[format])
                .toBuffer();
            var arrayBuffer = new ArrayBuffer(buffer.length);
            var typedArray = new Uint8Array(arrayBuffer);
            for (var i = 0; i < buffer.length; ++i) {
                typedArray[i] = buffer[i];
            }
            parentPort.postMessage({ fileKey, typedArray }, [typedArray.buffer]);
            console.log('Finished processing', fileKey);
        }),
    );
})();