# The model weights are NOT baked into this image: they download from Hugging Face on
# first boot into a volume mounted at /root/.cache/huggingface (see docker-compose.yml).
FROM pytorch/pytorch:2.8.0-cuda12.8-cudnn9-runtime

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY server.py steer.py ./
COPY vectors/vectors.npz vectors/summary.json vectors/

EXPOSE 8000
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000"]
