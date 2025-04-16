# Use the official Node.js image as a base
FROM node:18

# Set the working directory inside the container
WORKDIR /app

# Copy package.json and package-lock.json first (to leverage Docker cache)
COPY package*.json ./

# Install application dependencies
RUN npm install

# Copy the entire application into the container
COPY . .

# Expose the port your application runs on (e.g., 3000)
EXPOSE 3000

# Start the application when the container is run
CMD ["npm", "start"]
