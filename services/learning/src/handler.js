'use strict';

const { createHandler } = require('@learnloop/shared/src/http');
const routesModule = require('./routes');
const { jobs } = require('./jobs/reengagement');

const routes = routesModule.routes || routesModule.default || routesModule;

exports.handler = createHandler({
  name: 'learning',
  service: 'learning',
  routes,
  jobs
});