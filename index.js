/*******************************************************************
 *
 *  This module was heavily inspired by nunjucksify.
 *  (https://www.npmjs.com/package/nunjucksify)
 *
 *  Full credit to the original authors.
 *
 ******************************************************************/

const nunjucks = require('nunjucks');
const slash = require('slash');
const path = require('path');
const loaderUtils = require('loader-utils');

let env;
let hasRun = false;
let pathToConfigure;
let jinjaCompatStr;
let root;

module.exports = function(source) {
    if (this.target !== 'web') {
        throw new Error('[nunjucks-loader] non-web targets are not supported');
    }

    this.cacheable();

    if (!hasRun) {
        const query = loaderUtils.parseQuery(this.query);

        if (query) {
            env = new nunjucks.Environment([], query.opts || {});

            if (query.config) {
                pathToConfigure = query.config;
                try {
                    const configure = require(query.config);
                    configure(env);
                } catch (e) {
                    if (e.code === 'MODULE_NOT_FOUND') {
                        if (!query.quiet) {
                            const message =
                                `${'Cannot configure nunjucks environment before precompile\n' +
                                    '\t'}${e.message}\n` +
                                `Async filters and custom extensions are unsupported when the nunjucks\n` +
                                `environment configuration depends on webpack loaders or custom module\n` +
                                `resolve rules. If you are not using async filters or custom extensions\n` +
                                `with nunjucks, you can safely ignore this warning.`;
                            this.emitWarning(message);
                        }
                    } else {
                        this.emitError(e.message);
                    }
                }
            }

            // Specify the template search path, so we know from what directory
            // it should be relative to.
            if (query.root) {
                root = query.root;
            }

            // Enable experimental Jinja compatibility to be enabled
            if (query.jinjaCompat) {
                jinjaCompatStr = 'nunjucks.installJinjaCompat();\n';
            }
        } else {
            env = new nunjucks.Environment([]);
        }
        hasRun = true;
    }

    const name = slash(
        path.relative(
            root || this.rootContext || this.context,
            this.resourcePath
        )
    );

    let nunjucksCompiledStr = nunjucks.precompileString(source, {
        env,
        name,
    });

    nunjucksCompiledStr = nunjucksCompiledStr.replace(
        /window\.nunjucksPrecompiled/g,
        'nunjucks.nunjucksPrecompiled'
    );

    // ==============================================================================
    // replace 'require' filter with a webpack require expression (to resolve assets)
    // ==============================================================================
    const filterReg = /env\.getFilter\(\"require\"\)\.call\(context, \"(.*?)\"/g;
    nunjucksCompiledStr = nunjucksCompiledStr.replace(
        filterReg,
        'require("$1"'
    );

    // ================================================================
    // Begin to write the compiled template output to return to webpack
    // ================================================================
    let compiledTemplate = '';
    compiledTemplate +=
        'var nunjucks = require("nunjucks/browser/nunjucks-slim");\n';
    if (jinjaCompatStr) {
        compiledTemplate += `${jinjaCompatStr}\n`;
    }
    compiledTemplate += 'var env;\n';
    compiledTemplate += 'if (!nunjucks.currentEnv){\n';
    compiledTemplate +=
        '\tenv = nunjucks.currentEnv = new nunjucks.Environment([], { autoescape: true });\n';
    compiledTemplate += '} else {\n';
    compiledTemplate += '\tenv = nunjucks.currentEnv;\n';
    compiledTemplate += '}\n';
    if (pathToConfigure) {
        compiledTemplate += `var configure = require("${slash(
            path.relative(this.rootContext || this.context, pathToConfigure)
        )}")(env);\n`;
    }

    // =========================================================================
    // Find template dependencies within nunjucks (extends, import, include etc)
    // =========================================================================
    //
    // Create an object on nunjucks to hold the template dependencies so that they persist
    // when this loader compiles multiple templates.
    compiledTemplate +=
        'var dependencies = nunjucks.webpackDependencies || (nunjucks.webpackDependencies = {});\n';

    const templateReg = /env\.getTemplate\(\"(.*?)\"/g;
    let match;

    // Create an object to store references to the dependencies that have been included - this ensures that a template
    // dependency is only written once per file, even if it is used multiple times.
    const required = {};

    // Iterate over the template dependencies
    while ((match = templateReg.exec(nunjucksCompiledStr))) {
        const templateRef = match[1];
        if (!required[templateRef]) {
            // Require the dependency by name, so it gets bundled by webpack
            compiledTemplate += `dependencies["${templateRef}"] = require( "${templateRef}" );\n`;
            required[templateRef] = true;
        }
    }

    compiledTemplate += '\n\n\n\n';

    // Include a shim module (by reference rather than inline) that modifies the nunjucks runtime to work with the loader.
    compiledTemplate += `var shim = require("${slash(
        path.resolve(
            this.rootContext || this.context,
            `${__dirname}/runtime-shim`
        )
    )}");\n`;
    compiledTemplate += '\n\n';

    // Write the compiled template string
    compiledTemplate += `${nunjucksCompiledStr}\n`;

    compiledTemplate += '\n\n';

    // export the shimmed module
    compiledTemplate += `module.exports = shim(nunjucks, env, nunjucks.nunjucksPrecompiled["${name}"] , dependencies)`;

    return compiledTemplate;
};
