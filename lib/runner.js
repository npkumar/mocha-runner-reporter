'use strict';

const args		= require('minimist')(process.argv.slice(2)),
	colors		= require('colors'),
	fs			= require('fs'),
	helper      = require('./helper'),
	Mocha		= require('mocha'),
	pad			= require('pad-left'),
	path		= require('path'),
	stripAnsi	= require('strip-ansi'),
	wrap		= require('word-wrap');

module.exports = class Runner {
	/**
	 * Initialise a Runner
	 *
	 * @param {string|string[]} files   File(s) or path(s) containing the files to be used in the test run. Defaults to the third parameter (e.g. `node runner {file/path}`)
	 * @param {string[]} avoided        File(s) or path(s) to be excluded from the test run.
	 * @param {object} params           [Optional] Parameters used for the test, including arguments that can be passed to perform specified functions (See readme for structure).
	 * @param {number} attempts         [Optional] Number of times to run a test before reporting it as a failure.
	 */
	constructor (files, avoided, params, attempts) {
		// If no files have been supplied, default them to the third arg (node runner [file/path])
		!files && (files = [process.argv[2]]);

		// If help options have been requested, print them to the console and exit the process
		if (args.h || args.help || !files) {
			console.log(this._generateHelp(params));
			process.exit(0);
		}

		// Process the provided arguments
		this._processArgs(params);

		// Create the Mocha instance
		this._resetMocha();

		// Loop through the provided test files and populate the mocha instance
		!Array.isArray(files) && (files = [files]);
		files.forEach(testPath => {
			// Root path
			const root = path.join(process.cwd(), testPath || '.');

			if (root === process.cwd()) {
				console.log(this._generateHelp(params));
				throw new Error('Error: Test suite or file path required.');
			}

			try {
				const self = this;
				if (fs.statSync(root).isDirectory()) {
					/**
					 * Add the tests to the Mocha instance
					 */
					(function addFiles(dir, path) {
						fs.readdirSync(dir).filter(file => {
							if (!~avoided.indexOf(file)) {
								if (fs.statSync(`${dir}/${file}`).isDirectory()) {
									addFiles(`${dir}/${file}`, (path || '') + file + '/');
								}
								return file.endsWith('.js');
							}
						}).forEach(file => {
							self.mocha.addFile(`${dir}${file}`);
						});
					})(root);
				} else {
					self.mocha.addFile(root);
				}
			} catch (e) {
				throw new Error('Error processing files:\n' + e.message);
			}
		});

		// Store/create the parameters to be used during or after the test run
		this.fails = {};
		this.files = files;
		this.params = params;
		this.passes = {};
		this.pending = {};
		this.total = {};
		this.duration = {};
	}

	/**
	 * Run the supplied tests and returns the results.
	 *
	 * @returns {Promise} The result of the test run
	 */
	run () {
		return new Promise(resolve => {
			this.mocha.run()
				.on('test end', test => this._setDuration(test))
				.on('hook end', hook => this._setDuration(hook))
				.on('pass', test => this._setData(['passes', 'total'], test))
				.on('fail', (test, error) => this._setData(['fails', 'total'], test, error))
				.on('pending', test => this._setData(['pending', 'total'], test))
				.on('end', () => {
					// All tests have finished running now, so exit and return the collected data
					return resolve({
						passes: this.passes,
						failures: this.fails,
						timeTaken: this.duration,
						total: this.total,
						pending: this.pending
					});
				});
		});
	}

	/**
	 * Generates a body to be used in an email report
	 *
	 * @param {string} suiteName    Name of the test suite being ran
	 * @param {object} data         Data that was generated from the Mocha test run
	 *
	 * @returns {string} Body to be used in the report body
	 */
	generateReport (suiteName, data) {
		if (!suiteName) {
			throw new Error('No suite name provided for result email.');
		}
		if (!data) {
			throw new Error('No contents provided for result email. Either a complete body, or a data object containing passes, failures, skipped, and timeTaken are required.');
		}

		// Create the title
		// Magic number 12 being the length of 'Test Results', 6 being half of that, and 2 being a space either side.
		let title = '/' + '*'.repeat(Math.max(suiteName.length, 12) + 2) + '\\\n\n  ' +
			suiteName + '\n' + ' '.repeat(((Math.max(suiteName.length, 12) + 2) / 2) - 6) + 'Test Results\n\n' +
			'\\' + '*'.repeat(Math.max(suiteName.length, 12) + 2) + '/\n\n';

		const passes  = data.passes,
			failures  = data.failures,
			skipped   = data.pending,
			timeTaken = data.timeTaken,
			total     = data.total;

		let failedTestCount = 0,
			failureBody = '';

		let header = 'Overview:\n';

		// If there was only 1 test that was ran, we don't need as detailed of a report
		if (Object.keys(total).length === 1) {
			// Store the key used for this test
			const testKey = Object.keys(total)[0];

			// If no data exists for the values, use an empty array. That way .length calls return expected results
			!passes[testKey] && (passes[testKey] = []);
			!failures[testKey] && (failures[testKey] = []);
			!skipped[testKey] && (skipped[testKey] = []);

			const testCount = passes[testKey].length + failures[testKey].length + skipped[testKey].length;

			header += `- Suite Name : ${testKey}\n`;
			header += `- File       : ${total[testKey][0].test.file || total[testKey][0].test.parent.file}\n`;
			header += `- Passes     : ${passes[testKey].length} (${Math.round((100 / testCount * passes[testKey].length) * 100) / 100}%)\n`;
			header += `- Failures   : ${failures[testKey].length} (${Math.round((100 / testCount * failures[testKey].length) * 100) / 100}%)\n`;
			header += `- Skipped    : ${skipped[testKey].length} (${Math.round((100 / testCount * skipped[testKey].length) * 100) / 100}%)\n`;
			header += `- Duration   : ${helper.msToString(timeTaken.total) || +timeTaken.total || '0ms'}\n`;
			header += `- Start Time : ${new Date(Date.now() - (timeTaken.total || 0))}\n\n`;

			// If the test had failures, then generate the failure list for it
			if (failures[testKey].length) {
				failureBody += '|--------------------\n';
				failureBody += '| Failures:\n';
				failureBody += '|--------------------\n\n';

				for (let i = 0; i <= failures[testKey].length - 1; i++) {
					let failure = failures[testKey][i];
					failureBody += `Failure ${i + 1}:\n\n`;
					failureBody += `Name     : ${failure.test.title}\n`;
					failureBody += `Duration : ${helper.msToString(+failure.test.duration) || +failure.test.duration}\n`;
					failureBody += `Error    : ${stripAnsi(failure.error.stack || failure.error.message)}\n`;

					i + 1 < failures[testKey].length && (failureBody += '------------------------------\n\n');
				}
			}
		} else {
			// There was more than one test ran, so gather data for them all
			let totalPass = 0,
				totalFail = 0,
				totalSkip = 0;

			// Loop through all the test files and count how many total passes, failures, and skips there were
			for (let i = 0; i < Object.keys(total).length; i++) {
				for (let j = 0; j < total[Object.keys(total)[i]].length; j++) {
					switch (total[Object.keys(total)[i]][j].test.state) {
						case 'passed':
							totalPass++;
							break;
						case 'failed':
							totalFail++;
							break;
						default:
							totalSkip++;
							break;
					}
				}
			}
			const totalCount = totalPass + totalFail + totalSkip;

			header += `- Test Suites Ran : ${Object.keys(total).length}\n`;
			header += `- Total Passes    : ${+totalPass} (${Math.round((100 / totalCount * totalPass) * 100) / 100}%)\n`;
			header += `- Total Failures  : ${+totalFail} (${Math.round((100 / totalCount * totalFail) * 100) / 100}%)\n`;
			header += `- Total Skipped   : ${+totalSkip} (${Math.round((100 / totalCount * totalSkip) * 100) / 100}%)\n`;
			header += `- Total Duration  : ${helper.msToString(timeTaken.total) || +timeTaken.total || '0ms'}\n\n`;
			header += `- Start Time      : ${new Date(Date.now() - timeTaken.total)}\n\n`;

			// Loop through all the tests and generate detailed reports for them all
			for (let i = 0; i < Object.keys(total).length; i++) {
				const testKey = Object.keys(total)[i];

				// If no data exists for the values, use an empty array. That way .length calls return expected results
				!passes[testKey] && (passes[testKey] = []);
				!failures[testKey] && (failures[testKey] = []);
				!skipped[testKey] && (skipped[testKey] = []);

				const testCount = passes[testKey].length + failures[testKey].length + skipped[testKey].length;

				failureBody += '‖==============================\n';
				failureBody += `‖ ${testKey}\n`;
				failureBody += `‖==============================\n\n`;

				failureBody += `- File       : ${total[testKey][0].test.file || total[testKey][0].test.parent.file}\n`;
				failureBody += `- Passes     : ${passes[testKey].length} (${Math.round((100 / testCount * passes[testKey].length) * 100) / 100}%)\n`;
				failureBody += `- Failures   : ${failures[testKey].length} (${Math.round((100 / testCount * failures[testKey].length) * 100) / 100}%)\n`;
				failureBody += `- Skipped    : ${skipped[testKey].length} (${Math.round((100 / testCount * skipped[testKey].length) * 100) / 100}%)\n`;
				failureBody += `- Duration   : ${helper.msToString(timeTaken[testKey]) || +timeTaken[testKey]}\n\n`;

				// If the single test had failures, then generate the failure list for it
				if (failures[testKey].length) {
					failureBody += '|--------------------\n';
					failureBody += '| Failures:\n';
					failureBody += '|--------------------\n\n';

					for (let i = 0; i <= failures[testKey].length - 1; i++) {
						let failure = failures[testKey][i];
						failureBody += `Failure ${i + 1}:\n\n`;
						failureBody += `Name     : ${failure.test.title}\n`;
						failureBody += `Duration : ${helper.msToString(+failure.test.duration) || +failure.test.duration}\n`;
						failureBody += `Error    : ${stripAnsi(failure.error.stack || failure.error.message)}\n`;

						i + 1 < failures[testKey].length && (failureBody += '------------------------------\n\n');
					}

					failureBody += '=============================================\n\n';
				}
			}
		}

		return title + header + failureBody;
	}

	/**
	 * Generates a helper output for the test runner
	 *
	 * @param {object} params    Parameters supplied for the test
	 *
	 * @returns {string}         The generated helper string
	 */
	_generateHelp (params) {
		// If no parameters have been provided, don't generate a help output
		if (!params) {
			return;
		}

		// Include the default included mocha specific arguments
		params.args.push({
			aliases: ['t', 'timeout'],
			description: 'Time in milliseconds to wait before a test is counted as failing (Defaults to 300000)',
			type: 'number'
		});
		params.args.push({
			aliases: ['s', 'slow'],
			description: 'Time in milliseconds to wait before a test is counted as slow (Defaults to 10000)',
			type: 'number'
		});
		params.args.push({
			aliases: ['R', 'reporter'],
			description: 'Mocha reporter to use (Defaults to spec)',
			type: 'string'
		});

		//
		// Generate the Options string
		//

		let opts = '',
			optsArr = [],
			optsLen = 0;

		// Loop through the supplied parameters and create the string to use to show the usable arguments
		for (let i = 0; i <= params.args.length - 1; i++) {
			const arr = [];
			// If we weren't given an array, make one
			!Array.isArray(params.args[i].aliases) && (params.args[i].aliases = [params.args[i].aliases]);
			// Go through all of the aliases and store them with the correct formatting
			for (let j = 0; j <= params.args[i].aliases.length - 1; j++) {
				arr.push((params.args[i].aliases[j].length === 1 ? '-' : '--') + params.args[i].aliases[j]);
			}
			// Join the aliases together, and comma separate them
			let optsStr = arr.join(', '.grey);
			// If an argument type restriction is specified, add that to the output
			params.args[i].type && (optsStr += ` {${Array.isArray(params.args[i].type) ? params.args[i].type.join('|') : params.args[i].type}}`.cyan);
			// Check if the output is the longest one so far, and if so store its length for padding.
			stripAnsi(optsStr).length > optsLen && (optsLen = stripAnsi(optsStr).length);
			// All done here
			optsArr.push(optsStr);
		}
		// Add the descriptions for each option, with even padding.
		for (let i = 0; i <= optsArr.length - 1; i++) {
			const padSpace = optsLen - stripAnsi(optsArr[i]).length + params.args[i].description.length + 4;
			opts += '\n   ' + optsArr[i] + pad(params.args[i].description, padSpace, ' ');
		}

		// Generate the Notes string
		let notes = '';
		if (Array.isArray(params.notes)) {
			// If we have multiple notes, word-wrap them and separate them out
			for (var i = 0; i <= params.notes.length - 1; i++) {
				notes += '\n' + wrap(params.notes[i], {indent: '   ', width: 100}) + '\n';
			}
		} else {
			notes = '\n' + wrap(params.notes, {indent: '   ', width: 100}) + '\n';
		}

		// Define the title separately, makes it easier to colour the block
		const title = '\n' +
			'   ┌' + '─'.repeat(params.title.length + 2) + '┐\n' +
			'   │' + ' '.repeat(params.title.length + 2) + '│\n' +
			'   │ ' + params.title + ' │\n' +
			'   │' + ' '.repeat(params.title.length + 2) + '│\n' +
			'   └' + '─'.repeat(params.title.length + 2) + '┘\n\n';

		// Format the final output string and return it
		return title.cyan +
			'Description:\n\n'.bold +
			'   ' + params.description + '\n\n' +
			(params.usage ? '\nUsage:'.bold + '\n\n   ' + params.usage + '\n\n\n' : '\n') +
			'Options:'.bold + '\n' +
			opts + '\n' +
			(notes ? '\n\nNotes:'.bold + '\n' + notes : '');
	}

	/**
	 * Process the provided arguments using the data from the supplied params
	 *
	 * @param {object} params    Paramters to be processed
	 */
	_processArgs (params) {
		// Loop through all the supplied args
		for (let i = params.args.length - 1; i >= 0; i--) {
			// If there isn't a supplied function, then there isn't any point processing it
			if (params.args[i].function) {
				// If we weren't given an array, make one
				!Array.isArray(params.args[i].aliases) && (params.args[i].aliases = [params.args[i].aliases]);
				// Loop through each of the aliases for the argument
				for (let j = params.args[i].aliases.length - 1; j >= 0; j--) {
					// Check if the argument relating to the alias has been used, and if so call the supplied function with its value
					if (args[params.args[i].aliases[j]]) {
						params.args[i].function(args[params.args[i].aliases[j]]);
					}
				}
			}
		}
	}

	/**
	 * Reset the Mocha instance used for the tests
	 */
	_resetMocha () {
		this.mocha = new Mocha({
			ui:			args.u || args.ui		|| 'bdd',
			timeout:	args.t || args.timeout	|| 300000,
			slow:		args.s || args.slow		|| 10000,
			reporter:	args.R || args.reporter	|| 'spec',
			grep:		args.g || args.grep,
			useColors:!(args.C || args.nocolor)
		});
	}

	/**
	 * Loops through the nested parents of a provided test object and returns the title of the root suite
	 *
	 * @param  {object} test   Test object returned from Mocha
	 * @return {string}        Title of the root suite the test belongs to
	 */
	_getRootTestTitle (test) {
		if (!test) {
			return null;
		}

		if (!test.parent || test.parent.title === '') {
			return test.title;
		} else {
			return this._getRootTestTitle(test.parent);
		}
	}

	/**
	 * Store the duration of a provided test in the local and total duration stores,
	 * so long as the test has a valid duration.
	 *
	 * @param {object} test
	 */
	_setDuration (test) {
		const rootTitle = this._getRootTestTitle(test);
		!this.duration.total && (this.duration.total = 0);
		!this.duration[rootTitle] && (this.duration[rootTitle] = 0);

		test.duration && (this.duration.total += test.duration);
		test.duration && (this.duration[rootTitle] += test.duration);
	}

	/**
	 * Set the provided test data in the local store
	 *
	 * @param {string[]} keys   Keys of the local stores to use to store the data in
	 * @param {object} test     Test data to store in the specified stores
	 * @param {object} error    [Optional] Error data to store in the specified stores
	 */
	_setData (keys, test, error) {
		const rootTitle = this._getRootTestTitle(test);
		// For some reason mocha doesn't include the stack trace in the error response, so lets add it
		error && (error.stack = test.err.stack);
		keys.forEach(key => {
			this._addData(key, rootTitle, error ? {test, error} : {test});
		});
	}

	/**
	 * Generic function for adding data to a local object with a specified key
	 *
	 * @param {string} obj   Name of the object to add the data to
	 * @param {string} key   Key to use for the data to be added
	 * @param {any} data     The data to add
	 */
	_addData (obj, key, data) {
		// Check if the object exists already, and if not, define it.
		!this[obj][key] && (this[obj][key] = []);
		this[obj][key].push(data);
	}
};