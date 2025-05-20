const https = require('https');

// Replace 'your-service-url' with your actual Render service URL
const SERVICE_URL = 'https://islam-gpt-backend.onrender.com/health-check';

function pingService() {
  https.get(SERVICE_URL, (res) => {
    if (res.statusCode === 200) {
      console.log('Service pinged successfully');
    } else {
      console.error(`Service ping failed with status code: ${res.statusCode}`);
    }
  }).on('error', (e) => {
    console.error(`Ping error: ${e.message}`);
  });
}

// Ping the service every 14 minutes
setInterval(pingService, 5 * 60 * 1000);

module.exports = pingService;