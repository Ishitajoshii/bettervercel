// CloudFront Functions runtime, also executed in the local routing tests.
function handler(event) {
  var request = event.request;
  var uri = request.uri;
  if (uri === '/' || uri === '/dashboard') return { statusCode: 308, statusDescription: 'Permanent Redirect',
    headers: { location: { value: '/dashboard/' } } };
  if (/^\/dashboard\/(?:index\.html|app\.js|style\.css|config\.json)?$/.test(uri)) {
    if (uri === '/dashboard/') request.uri += 'index.html';
    return request;
  }
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
  var apiDeployment = /^(p[a-f0-9]{16})-[a-f0-9]{32}$/.exec(match[1]);
  if (apiDeployment && (path === '/_spa' || path.indexOf('/_spa/') === 0)) {
    if (path === '/_spa') return { statusCode: 308, statusDescription: 'Permanent Redirect',
      headers: { location: { value: uri + '/' } } };
    var spaPath = path.substring('/_spa'.length);
    // Only extensionless routes fall back. Dotted paths (including missing assets)
    // remain exact object requests. Queries remain on the viewer URL.
    if (spaPath.indexOf('.') === -1) spaPath = '/index.html';
    request.uri = '/deployments/' + apiDeployment[1] + '/_spa/' + match[1] + spaPath;
    return request;
  }
  // Support exported /about/index.html without a global SPA fallback.
  if (path.endsWith('/')) path += 'index.html';
  else if (path.substring(path.lastIndexOf('/') + 1).indexOf('.') === -1) {
    return { statusCode: 308, statusDescription: 'Permanent Redirect',
      headers: { location: { value: uri + '/' } } };
  }
  request.uri = '/deployments/' + (apiDeployment ? apiDeployment[1] + '/' : '') + match[1] + path;
  return request;
}
