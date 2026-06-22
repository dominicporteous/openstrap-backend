FROM node:20 AS base

WORKDIR /app

# Copy package files
COPY package.json package-lock.json ./

# Install all dependencies (including devDependencies like wrangler)
RUN npm install

# Copy source code
COPY tsconfig.json wrangler.toml ./
COPY src/ ./src/

# Expose the default wrangler dev port
EXPOSE 8787

# Start wrangler dev server
CMD ["npm", "run", "dev", "--", "--ip", "0.0.0.0"]