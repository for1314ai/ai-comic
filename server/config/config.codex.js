'use strict';

const path = require('path');

// Egg reads the bind address from cluster.listen, not startCluster.hostname.
exports.cluster = { listen: { hostname: '127.0.0.1', port: 7001 } };
exports.serverTimeout = 11 * 60 * 1000;
exports.logger = { dir: path.join(__dirname, '../logs') };
