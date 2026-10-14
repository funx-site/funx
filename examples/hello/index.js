'use strict';
// Funx example: returns JSON with the current time and the request path.
exports.handler = async (event) => ({
  statusCode: 200,
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ hello: 'funx', time: new Date().toISOString(), path: event.path, method: event.method }),
});
