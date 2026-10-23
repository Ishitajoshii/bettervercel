// CloudFront Functions runtime, also executed in the local routing tests.
function handler(event) {
  var request = event.request;
  var uri = request.uri;
  var match = /^\/d\/([a-z0-9][a-z0-9-]{0,62})(\/.*)?$/.exec(uri);
  if (!match || /%2e|%2f|%5c|\\|(?:^|\/)\.{1,2}(?:\/|$)/i.test(uri)) {
    return { statusCode: 404, statusDescription: 'Not Found' };
  }
  if (!match[2]) {
    return {
      statusCode: 308, statusDescription: 'Permanent Redirect',
      headers: { location: { value: '/d/' + match[1] + '/' } }
    };
  }
  var path = match[2];
  // Support exported /about/index.html without a global SPA fallback.
  if (path.endsWith('/')) path += 'index.html';
  else if (path.substring(path.lastIndexOf('/') + 1).indexOf('.') === -1) {
    return { statusCode: 308, statusDescription: 'Permanent Redirect',
      headers: { location: { value: uri + '/' } } };
  }
  var apiDeployment = /^(p[a-f0-9]{16})-[a-f0-9]{32}$/.exec(match[1]);
  request.uri = '/deployments/' + (apiDeployment ? apiDeployment[1] + '/' : '') + match[1] + path;
  return request;
}
