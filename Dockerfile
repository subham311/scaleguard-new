FROM node:18-alpine

ARG SHOPIFY_API_KEY
ENV SHOPIFY_API_KEY=$SHOPIFY_API_KEY
EXPOSE 8081
WORKDIR /app
COPY web .
RUN npm install
RUN npx prisma generate
RUN cd frontend && npm install && npm run build

# Run migrations and start the server
CMD npx prisma migrate deploy && npm run serve


