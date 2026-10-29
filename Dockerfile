FROM node:22-alpine

WORKDIR /app

COPY . .

RUN mkdir -p search-requests search-results

EXPOSE 3456

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3456/api/health',r=>{process.exit(r.statusCode===200?0:1)})"

CMD ["node", "bridge-server.js"]
