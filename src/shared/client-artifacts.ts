/** Package-local lazy chunks shared by build, installation and distribution. */
export const CLIENT_CHUNK_NAMES = ['voice', 'capture'] as const;
export const CLIENT_CHUNKS = CLIENT_CHUNK_NAMES.map(name => `client.${name}.js`);
