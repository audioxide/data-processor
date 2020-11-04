const fs = require('fs');
const { resolve } = require('path');

const baseOutputDir = '/Users/andrew.bridge/Projects/audioxide-data/data/images';

const dimensions = [];

const skipped = [];

const copied = [];

const parseFile = async (path) => {
    const resizedSplit = path.match(/^(.+?)-(\d{1,4}x\d{1,4})(.[a-zA-Z]{2,4})$/);
    if (resizedSplit) {
        // This is a resized image, add it to the dimensions list and skip it on
        const [match, filename, resizeDimensions, extension] = resizedSplit;
        if (!dimensions.includes(resizeDimensions)) dimensions.push(resizeDimensions);
        skipped.push(path);
        return;
    }
    // This is an original image, copy it
    await fs.promises.copyFile(resolve('./' + path), baseOutputDir + path);
    copied.push(path);
};

const parseDir = async (path) => {
    const files = await fs.promises.readdir(resolve('./' + path));
    await Promise.all(files.map(async file => {
        const filePath = `${path}/${file}`;
        if (file.substr(0, 1) === '.') return;
        const stat = await fs.promises.stat(resolve('./' + filePath));
        if (stat.isDirectory()) {
            if (!(fs.existsSync(baseOutputDir + filePath))) {
                await fs.promises.mkdir(baseOutputDir + filePath, { recursive: true });
            }
            await parseDir(filePath);
        } else if (stat.isFile()) {
            await parseFile(filePath);
        }
    }));
};

const main = async () => {
    // Parse data
    await parseDir('');
    await fs.promises.writeFile(`${baseOutputDir}/sizes.json`, JSON.stringify(dimensions));
    await fs.promises.writeFile('report.json', JSON.stringify({ skipped, copied }));
    console.log(`Completed import; Copied ${copied.length}, skipped ${skipped.length}`);
};

main();