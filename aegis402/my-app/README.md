# my-app

## Development

### Setup & Local Testing
```bash
npm install
cp .env.example .env
npm run dev
```

### Docker Testing
```bash
docker build -t my-app .
docker run --rm --env-file .env my-app
```

## Prerequisites

Before deploying, you'll need:

- **Docker** - To package and publish your application image
- **ETH** - To pay for deployment transactions

## Deployment

```bash
ecloud compute app deploy username/image-name
```

The CLI will automatically detect the `Dockerfile` and build your app before deploying.

## Management & Monitoring

```bash
ecloud compute app list                    # List all apps
ecloud compute app info [app-name]         # Get app details
ecloud compute app logs [app-name]         # View logs
ecloud compute app start [app-name]        # Start stopped app
ecloud compute app stop [app-name]         # Stop running app
ecloud compute app terminate [app-name]    # Terminate app
ecloud compute app upgrade [app-name] [image] # Update deployment
```
