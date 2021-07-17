#!/usr/bin/env node

const { S3Client, ListBucketsCommand, PutObjectCommand, ListObjectsV2Command } = require("@aws-sdk/client-s3");
const fs = require('fs/promises');
const { createReadStream } = require('fs');
const nodePath = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const { Worker } = require('worker_threads');

const {
    S3_ENDPOINT,
    S3_REGION,
    S3_ACCESS_KEY,
    S3_SECRET_KEY,
    ORIGINALS_BUCKET,
    PROCESSED_BUCKET,
} = process.env;

const client = new S3Client({
    endpoint: S3_ENDPOINT,
    region: S3_REGION,
    credentials: {
        accessKeyId: S3_ACCESS_KEY,
        secretAccessKey: S3_SECRET_KEY,
    }
});

/**
 * Have a bucket of originals. List these out and compare that list to
 * the list of images in the data repo (and by checksum for full fanciness)
 * 
 * Any that don't match the originals list, process appropriately and add
 * those transformations to another bucket
 * 
 * Could also potentially upload the sizes.json that was used to generate
 * and have a full dump and re-generate if the two are different
 */

const dummySizeConfig = {
    "variations": {
        "original": null,
        "square": 1,
        "standard": 1.5
    },
    "sizes": {
        "xsmall": 300,
        "small": 600,
        "medium": 768,
        "large": 1026,
        "xlarge": 1500
    },
    formats: ['[original]', 'webp', 'avif']
};

const imagesSizes = [];
const resolveImageSizes = ({ variations, sizes, formats }) => Object.entries(sizes)
 .forEach(([label, w]) => Object.entries(variations)
     .forEach(([variation, ratio]) => formats
        .forEach(format => imagesSizes.push({
            name: `${label}-${variation}`,
            format,
            h: Number.isFinite(ratio) ? w / ratio : undefined,
            w,
        }))));

function checksumFile(path) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('md5');
        const stream = createReadStream(path);
        stream.on('error', err => reject(err));
        stream.on('data', chunk => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
    });
}

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

const queue = new Set();
const remoteFiles = {};
const processFile = async (path) => {
    const rootlessPath = path.substr(1);
    const localChecksum = await checksumFile(inputBase + path);
    const remoteExists = rootlessPath in remoteFiles;
    const checksumMatches = localChecksum === remoteFiles[rootlessPath];
    if (remoteExists && checksumMatches) return; // Image does not need processing
    const { dir, name: filename, ext } = nodePath.parse(path);
    const sharpExt = ext === '.jpg' ? 'jpeg' : ext.substr(1);
    if (!(sharpExt in sharp.format)) return;
    // if (ext !== '.jpg' || filename.substr(0, 1) !== 'a' || dir.indexOf('artwork') === -1) return;
    while (queue.size > 20) {
        await Promise.race([...queue]);
    }
    console.log(`Adding ${path} to the queue; queue size: ${queue.size}`);
    // const metadata = await image.metadata();
    // imageMax[originalPath] = { w: metadata.width, h: metadata.height };
    const job = new Promise((resolve, reject) => {
        const worker = new Worker(nodePath.join(__dirname, 'processImage.js'), {
            workerData: { imagesSizes, path, inputBase }
        });
        let workerExited, uploadComplete;
        Promise.all([
            new Promise((workerResolve) => workerExited = workerResolve),
            new Promise((uploadResolve) => uploadComplete = uploadResolve),
        ]).then(resolve);
        worker.on('message', async ({ fileKey, typedArray }) => {
            var bufferObject = new Buffer.alloc(typedArray.byteLength)
            for (var i = 0; i < typedArray.length; i++) {
                bufferObject[i] = typedArray[i];
            }
            const command = new PutObjectCommand({
                Key: fileKey,
                Bucket: PROCESSED_BUCKET,
                Body: bufferObject
            });
            console.log('Preparing to upload', fileKey);
            await client.send(command);
            console.log('Uploaded', fileKey);
            uploadComplete();
        });
        worker.on('exit', (code) => {
            if (code !== 0) {
                return reject(new Error(`Worker stopped with exit code ${code}`));
            }
            workerExited();
        });
    });
    queue.add(job);
    await job;
    queue.delete(job);
    const command = new PutObjectCommand({
        Key: path.substr(1),
        Bucket: ORIGINALS_BUCKET,
        Body: await fs.readFile(inputBase + path),
    });
    await client.send(command);
    console.log(`Marked "${path}" complete`);
    // await Promise.all(
    //     imagesSizes.map(async ({ name: sizename, w, h, format }) => {
    //         // TODO: Rework this so it goes into a temp directory
    //         // TODO: Ensure just setting the extension correctly formats
    //         const fileExt = format === '[original]' ? ext.substr(1) : format;
    //         const fileKey = `${dir.substr(1)}/${filename}-${sizename}.${fileExt}`;
    //         // sizeObj[sizename] = API_URL + fileKey;
    //         // console.log(fileKey);
    //         console.log('Starting to process', fileKey);
    //         let imageOperation = image.clone()
    //             .resize(w, h, { withoutEnlargement: true })
    //         if (format !== '[original]') {
    //             imageOperation = imageOperation.toFormat(format);
    //         }
    //         const buffer = await imageOperation.toBuffer();
    //         console.log('Finished processing', fileKey);
    //         const command = new PutObjectCommand({
    //             Key: fileKey,
    //             Bucket: PROCESSED_BUCKET,
    //             Body: buffer
    //         });
    //         const response = await client.send(command);
    //         console.log('Uploaded', fileKey, response);
    //     }),
    // );
    // const command = new PutObjectCommand({
    //     Key: path.substr(1),
    //     Bucket: ORIGINALS_BUCKET,
    //     Body: await fs.readFile(inputBase + path),
    // });
    // return client.send(command);
    // Transform image as necessary
    // Upload original to originals bucket
    // Uploader transformations to transformation bucket 
};

(async () => {
    // imageConfig = JSON.parse(
    //     await fs.promises.readFile(
    //         `${inputBase}${imagesBase}/sizes.json`,
    //         { encoding: 'utf8' },
    //     ),
    // );
    resolveImageSizes(dummySizeConfig);
    // const command = new ListBucketsCommand({});
    // const command = new PutObjectCommand({
    //     Key: 'test-image.svg',
    //     Bucket: 'andrewbridge-test-bucket',
    //     Body: await fs.readFile('/Users/andrewbridge/Downloads/image.psd(1).svg')
    // })
    const command = new ListObjectsV2Command({
        Bucket: ORIGINALS_BUCKET,
    });
    const { Contents = [] } = await client.send(command);
    // const remoteFiles = {};
    for (const item of Contents) {
        const tag = item.ETag;
        remoteFiles[item.Key] = tag.substr(1, tag.length - 2);
    }
    await parseDir('');
})()