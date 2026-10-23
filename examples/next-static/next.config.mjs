const basePath = process.env.BETTERVERCEL_BASE_PATH || '';
export default { output: 'export', trailingSlash: true, basePath, images: { unoptimized: true } };
