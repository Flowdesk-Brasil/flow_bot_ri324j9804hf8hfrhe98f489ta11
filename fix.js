const fs = require('fs');
const content = fs.readFileSync('site/.env');
const lines = content.toString('utf8').split('\n');
const cleanLines = [];
for (const line of lines) {
  if (line.includes('FLOWDESK_DOMAIN_REGISTRANT_DOCUMENT_NUMBER')) {
    cleanLines.push('FLOWDESK_DOMAIN_REGISTRANT_DOCUMENT_NUMBER=51601711000152');
    break;
  }
  cleanLines.push(line);
}
cleanLines.push('');
cleanLines.push('HOSTING_AGENT_BASE_URL="http://2.25.183.234:5001"');
cleanLines.push('HOSTING_AGENT_TOKEN="flowdesk-super-secret-token-v1"');
fs.writeFileSync('site/.env', cleanLines.join('\n'));
console.log("Fixed!");
