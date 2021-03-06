const fs = require('fs');
const nodePath = require('path');
const { default: Parcel } = require('@parcel/core');

module.exports = class ComponentBundler {
    entries = [];

    static styleEntrypoints = ['static', 'component']
        .reduce(
            (acc, prefix) => acc.concat(
                ['scss', 'sass', 'css'].map(suffix => `${prefix}.${suffix}`),
            ),
            [],
        );

    static getComponentFile(directory) {
        return nodePath.join(directory, '/component.js');
    }

    constructor(componentDirectory) {
        this.inputDir = componentDirectory;
        this.addEntryPoint(this.inputFile);
    }

    get inputFile() {
        return ComponentBundler.getComponentFile(this.inputDir);
    }

    addEntryPoint(entryPoint) {
        this.entries.push(nodePath.resolve(entryPoint));
    }

    async bundle(outputDirectory) {
        const { entries } = this;
        let bundler = new Parcel({
            entries,
            distDir: outputDirectory,
            defaultConfig: nodePath.join(__dirname, "parcelConfig.json"),
            defaultEngines: {
              browsers: ["defaults and supports custom-elementsv1"],
              node: "14",
            },
            mode: "production",
            sourceMaps: false,
        });

        await bundler.run();
    }
}
