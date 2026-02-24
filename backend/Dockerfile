# Use the official Python 3.11 slim image
FROM python:3.11-slim

# Set working directory inside the container
WORKDIR /app

# Set environment variables
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# Install system dependencies (needed for OpenCV and image processing libraries)
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    libgl1-mesa-glx \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements file to leverage Docker cache
COPY requirements.txt .

# Install Python dependencies without cache to keep image small
RUN pip install --no-cache-dir -r requirements.txt

# Copy the application code
COPY ./app /app/app

# Expose port (Cloud Run defaults to 8080)
EXPOSE 8080

# Command to run the application using uvicorn
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
