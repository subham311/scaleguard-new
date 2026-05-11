FROM node:18-alpine

ARG SHOPIFY_API_KEY
ENV SHOPIFY_API_KEY=$SHOPIFY_API_KEY
EXPOSE 8081

WORKDIR /app

# Copy the entire project to handle workspaces correctly
COPY . .

# Install all dependencies (handles root and workspaces)
RUN npm install

# Build the app using Shopify CLI
RUN npx shopify app build


# Generate Prisma client inside the web folder
WORKDIR /app/web
RUN npx prisma generate

# Run migrations and start the server
CMD npx prisma migrate deploy && npm run serve



