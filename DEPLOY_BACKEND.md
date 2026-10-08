# Backend Deployment

This app needs a Node.js backend for `/api`. GitHub Pages can only host the static frontend, so deploy the full app to a Node host such as Render.

## Google sign-in

Create an OAuth 2.0 **Web application** client in Google Cloud, then add `https://mnasah.onrender.com` (and the local development origin when needed) to its authorized JavaScript origins. Set the same client ID in Render as both `GOOGLE_CLIENT_ID` and `VITE_GOOGLE_CLIENT_ID`. The backend validates the Google credential and its audience; the frontend button stays disabled until these values are configured and a new build is deployed.

Use these settings:

```text
Build command: npm ci && npm run build:backend
Start command: npm start
```

Environment variables:

```text
MONGODB_URI=mongodb://ac-iqhu1dx-shard-00-00.9d1jvri.mongodb.net:27017,ac-iqhu1dx-shard-00-01.9d1jvri.mongodb.net:27017,ac-iqhu1dx-shard-00-02.9d1jvri.mongodb.net:27017/?ssl=true&replicaSet=atlas-gf9cqv-shard-0&authSource=admin&retryWrites=true&w=majority&appName=Cluster0
MONGODB_USER=takee12345678900_db_user
MONGODB_PASSWORD=your-database-password
MONGODB_DB=manasah
CLIENT_ORIGIN=https://taqyalhrainy.github.io
OWNER_SETUP_TOKEN=use-a-long-random-secret
NODE_ENV=production
```

After deployment, open the deployed backend URL. It serves both the frontend and API from the same domain.
