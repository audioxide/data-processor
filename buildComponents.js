const fs = require('fs');
const nodePath = require('path');
const { default: Parcel } = require('@parcel/core');

/* const DEFAULT_INPUT_OPTIONS = {
	plugins: [
		resolve({ preferBuiltins: true }),
		commonjs(),
		json(),
		injectProcessEnv({}),
		terser(),
	],
};

const DEFAULT_OUTPUT_OPTIONS = {
    format: 'iife',
};

const getInputFile = (componentDirectory) => nodePath.resolve(path + '/component.js');
const getConfigFile = (componentDirectory) => nodePath.resolve(path + '/rollup.config.js');

const getUserConfig = async (path, outputFilePath) => {
    const { options, warnings } = await loadConfigFile(
        getConfigFile(path),
        {
            input: getInputFile(path),
            file: nodePath.resolve(outputFilePath),
        },
    );

    console.log(`We currently have ${warnings.count} warnings`);
    warnings.flush();

    return options;
}

const getDefaultConfig = (path, outputFilePath) => new Promise((resolve) => resolve([
    {
        input: getInputFile(path),
        output: [
            {
                file: nodePath.resolve(outputFilePath),
                ...DEFAULT_OUTPUT_OPTIONS,
            },
        ],
        ...DEFAULT_INPUT_OPTIONS,
    },
]));

export default async (componentDirectory, outputFilePath) => {
    const configResolver = fs.existsSync(getConfigFile(componentDirectory)) ? getUserConfig : getDefaultConfig;
    const options = await configResolver(componentDirectory, outputFilePath);
    for (const optionsObj of options) {
        const bundle = await rollup.rollup(optionsObj);
        await Promise.all(optionsObj.output.map(bundle.write));
    }
} */

module.exports = class ComponentBundler {
    entries = [];

    constructor(componentDirectory) {
        this.inputDir = componentDirectory;
        this.addEntryPoint(this.inputFile);
    }

    get inputFile() {
        return nodePath.join(this.inputDir, '/component.js');
    }

    addEntryPoint(entryPoint) {
        this.entries.push(nodePath.resolve(entryPoint));
    }

    async bundle(outputDirectory) {
        const { entries } = this;
        let bundler = new Parcel({
            entries,
            distDir: outputDirectory,
            defaultConfig: require.resolve("@parcel/config-default"),
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
