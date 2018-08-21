var pm2 = require('pm2'),
    crypto = require('crypto'),
    http = require('http'),
    _ = require('lodash'),
    spawn = require('child_process').spawn,
    async = require('async');

var servers = {};
var webhooks = {};
// Environment problem for process
module.exports = function () {
    pm2.connect(function () {
        pm2.list(function (err, procs) {
            processList(procs);
        });

        pm2.launchBus(function (err, bus) {
            bus.on('process:event', function (proc) {
                if (proc && proc.event == 'online' && !_.has(webhooks, proc.process.name)) {
                    var env = proc.process.env_webhook;

                    if (!env) return;

                    var port = parseInt(env.port);

                    if (port <= 1024) {
                        console.error( (new Date() ).toString() + ':Error! Port must be greater than 1024, you are trying to use', port);
                        return;
                    }

                    webhooks[proc.process.name] = {
                        port: port,
                        path: env.path || '',
                        type: env.type || 'pullAndRestart',
                        pre_hook: env.pre_hook || '',
                        post_hook: env.post_hook || '',
                        request_branch : env.request_branch || 'push.changes[0].new.name',
                    };

                    try {
                        webhooks[proc.process.name] && addServer(env.port);
                    } catch(error) {
                        console.error( (new Date() ).toString() + ':Error occurs while creating server', error);
                    }

                }

                if (proc && proc.event == 'exit' && _.has(webhooks, proc.process.name)) {
                    try {
                        webhooks[proc.process.name] && removeServer( webhooks[proc.process.name].port );
                    } catch(error) {
                        console.error( (new Date() ).toString() + ':Error occurs while removing server', error);
                    }

                    webhooks[proc.process.name] && delete webhooks[proc.process.name];
                }
            })
        });
    });
};

function processList(processes) {

    console.log( (new Date() ).toString() + ':Start webhook!');
    console.log( (new Date() ).toString() + ':Found', _.result(processes, "length"), 'processes');

    processes.forEach(function (proc) {
        console.log( (new Date() ).toString() + ':Process', proc.name);

        if (!_.result(proc,"pm2_env", false) || !_.result(proc, "pm2_env.env_webhook", false) || !_.result(proc,"pm2_env.env_webhook.port", false)) {
            console.error( (new Date() ).toString() + ':Environment problem for process', proc.name);
            return;
        }

        var env = _.result(proc, "pm2_env.env_webhook");

        var port = parseInt(env.port);

        console.log( (new Date() ).toString() + ':Process port', port, 'for process', proc.name);

        if (port <= 1024) {
            console.error( (new Date() ).toString() + ':Error! Port must be greater than 1024, you are trying to use', port);
            return;
        }

        if (!_.has(servers, port)) {
            try {
                addServer(port);
            } catch(error) {
                console.error( (new Date() ).toString() + ':Error occurs while creating server', error);
            }
        }

        webhooks[proc.name] = {
            port: port,
            path: env.path || '/',
            type: env.type || 'pullAndRestart',
            pre_hook: env.pre_hook || '',
            post_hook: env.post_hook || '',
            request_branch : env.request_branch || 'push.changes[0].new.name',
        };
    });
}

function processRequest(port, url, body, headers) {
    'use strict';

    for (const name of Object.keys(webhooks)) {
        var options = webhooks[name];

        if (options.port !== port) {
            continue;
        }

        if (options.path.length && options.path != url) {
            continue;
        }

        var checkOrigin = new Promise(function(resolve, reject){
            var origin;

            try {
                origin = JSON.parse(body);
                origin = _.result(origin, options.request_branch, '').toString().split('/').slice(-1)[0];
            } catch (e){
                console.log( (new Date() ).toString() + ':Error! Check origin failed.');
                return reject(e);
            }

            pm2.describe(name, function (err, apps) {
                if (err || !apps || apps.length === 0) return reject(err || new Error('Application not found'));

                var reqOrigin = _.find(apps, function (e) {
                    return e
                        && e.pm2_env
                        && e.pm2_env.versioning
                        && e.pm2_env.versioning.branch
                        && e.name == name ;
                });

                resolve( reqOrigin.pm2_env.versioning.branch.toLowerCase() == origin.toLowerCase() );
            });
        });

        checkOrigin
            .then(function (isCorrectOrigin) {
                if (isCorrectOrigin) {
                    pullAndReload(name);
                }
                else {
                    console.log( (new Date() ).toString() + ':Webhook from invalid branch (Application:', name, ')');
                }
            })
            .catch(function () {
                console.error( (new Date() ).toString() + ':Something went wrong while chocking origin (Application:', name, ')');
            });
    }
}

function addServer(port) {
    console.info('Create server on port ', port);

    servers[port] = http
        .createServer(function (request, response) {
            response.writeHead(200, {'Content-Type': 'text/plain'});
            response.write('Received');
            response.end();

            if (request.method !== 'POST') {
                return;
            }

            var body = '';
            request
                .on('data', function(data) {
                    body += data;
                })
                .on('end', function () {
                    processRequest(port, request.url, body, request.headers);
                });

        })
        .listen(port)
        .unref();
}

function removeServer(port) {

    if (!servers[port]) {
        return;
    }

    console.info( (new Date() ).toString() + ':Remove server on port ', port);

    servers[port].close(function(err) {
        if (err) return console.error( (new Date()).toString() + ':Error occurs while removing server on port ', err);
        delete servers[port];
    });
}

function pullAndReload(name) {
    var current_app = webhooks[name];

    async.series([
        // Pre-hook
        function (callback) {
            if (!current_app.pre_hook) return callback(null);

            pm2.describe(name, function (err, apps) {
                if (err || !apps || apps.length === 0) return callback(err || new Error('Application not found'));

                var cwd = apps[0].pm_cwd ? apps[0].pm_cwd : apps[0].pm2_env.pm_cwd;
                var run = current_app.pre_hook.split(' ');

                var child = spawn(run[0], run.splice(1), {cwd: cwd, maxBuffer: 1024 * 500 });

                child.stdout.on('data', function (data) {
                  console.log( (new Date() ).toString() + ':' +  name + ':stdout: ' + data);
                });

                child.stderr.on('data', function (data) {
                  console.error( (new Date()).toString() + ':' + name + ':stderr: ' + data);
                });

                child.on('close', function (code) {
                    console.log( (new Date() ).toString() + ':Pre-hook command has been successfully executed for app %s', name);
                    return callback(null);
                });
            })
        },

        // Pull and restart
        function (callback) {
            console.log( (new Date() ).toString() + ':Try to pull', name);
            pm2[current_app.type].call(pm2, name, function (err, meta) {
                if (err) return callback(err);
                console.log( (new Date() ).toString() + ':' +  "Successfuly", current_app.type, "application", name);
                return callback(null);
            })
        },

        // Post-hook
        function (callback) {
            if (!current_app.post_hook) return callback(null);

            pm2.describe(name, function (err, apps) {
                if (err || !apps || apps.length === 0) return callback(err || new Error('Application not found'));

                var cwd = (apps[0].pm_cwd ? apps[0].pm_cwd : apps[0].pm2_env.pm_cwd );
                var run = current_app.post_hook.split(' ');

                var child = spawn(run[0], run.splice(1), {cwd: cwd, maxBuffer: 1024 * 1024 });

                child.stdout.on('data', function (data) {
                  console.log( (new Date() ).toString() + ':' +  name + ':post:stdout: ' + data);
                });

                child.stderr.on('data', function (data) {
                  console.error( (new Date()).toString() + ':' + name + ':post:stderr: ' + data);
                });

                child.on('close', function (code) {
                    console.log( (new Date() ).toString() + ':Post-hook command has been successfully executed for app', name);
                    callback(null);
                });
            })
        }
    ], function (err, results) {
        if (err) {
            console.error( (new Date() ).toString() + ':An error has occuring while processing app', name);
            console.error( (new Date() ).toString() + ':' +  err);
        }
    })
}
