const fs = require('fs');

const files = ['update.js', 'backfill.js', 'scan-vietsub.js'];

const replacement = `let encoded = data.content || '';
  if (!encoded) {
    const blobRes = await fetch(\`https://api.github.com/repos/\${TARGET_REPO}/git/blobs/\${data.sha}\`, {
      headers: {
        Authorization: \`Bearer \${GH_TOKEN}\`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'xiec-large-json-reader'
      }
    });
    if (!blobRes.ok) throw new Error(\`GitHub blob read failed: \${blobRes.status} \${await blobRes.text()}\`);
    const blob = await blobRes.json();
    encoded = blob.content || '';
  }
  const decodedText = Buffer.from(encoded.replace(/\\n/g, ''), 'base64').toString('utf8');`;

for (const file of files) {
  let s = fs.readFileSync(file, 'utf8');
  const before = s;

  if (file === 'update.js') {
    s = s.replace(
      "const text = Buffer.from(data.content.replace(/\\n/g, ''), 'base64').toString('utf8');\n  return { sha: data.sha, json: JSON.parse(text) };",
      `${replacement}\n  return { sha: data.sha, json: JSON.parse(decodedText) };`
    );
  }

  if (file === 'backfill.js') {
    s = s.replace(
      "const movies = JSON.parse(Buffer.from(data.content.replace(/\\n/g, ''), 'base64').toString('utf8'));\n  return { sha: data.sha, movies };",
      `${replacement}\n  const movies = JSON.parse(decodedText);\n  return { sha: data.sha, movies };`
    );
  }

  if (file === 'scan-vietsub.js') {
    s = s.replace(
      "return {\n    sha: data.sha,\n    movies: JSON.parse(Buffer.from(data.content.replace(/\\n/g, ''), 'base64').toString('utf8'))\n  };",
      `${replacement}\n  return {\n    sha: data.sha,\n    movies: JSON.parse(decodedText)\n  };`
    );
  }

  if (s === before) {
    console.log(`PATCH_SKIP ${file}: pattern not found or already patched`);
  } else {
    fs.writeFileSync(file, s);
    console.log(`PATCH_OK ${file}`);
  }
}
