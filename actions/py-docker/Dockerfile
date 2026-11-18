FROM python:3.13-slim
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt
COPY main.py /app/main.py
ENTRYPOINT ["python", "/app/main.py"]
