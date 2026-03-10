# Stage 1: Build frontend
FROM node:20-alpine AS frontend
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.js style.css ./
COPY src/ src/
COPY assets/ assets/
RUN npm run build && \
    cp style.css dist/ && \
    cp -r assets dist/

# Stage 2: Python backend + built frontend
FROM python:3.12-slim
WORKDIR /app

COPY auxserver/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY auxserver/ ./

# Copy built frontend into static directory served by FastAPI
COPY --from=frontend /app/dist /app/static/game

EXPOSE 8001

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8001"]
