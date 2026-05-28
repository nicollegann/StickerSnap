# ── Stage 1: builder ──────────────────────────────────────────────────────────
FROM public.ecr.aws/lambda/python:3.11 AS builder

# Upgrade GCC via SCL (Software Collections) — gives GCC 11 on this image
RUN yum install -y \
    gcc10 \
    gcc10-c++ \
    gcc10-binutils \
    libffi-devel \
    libjpeg-turbo-devel \
    zlib-devel \
    libwebp-devel \
    && yum clean all

# Point cc/c++ to gcc10
ENV CC=gcc10-gcc
ENV CXX=gcc10-g++

WORKDIR /install
COPY requirements.txt .

RUN pip install --no-cache-dir --upgrade pip \
    && pip install \
       --no-cache-dir \
       --target /install/packages \
       -r requirements.txt

# ── Stage 2: final ────────────────────────────────────────────────────────────
FROM public.ecr.aws/lambda/python:3.11

COPY --from=builder /install/packages ${LAMBDA_TASK_ROOT}
COPY handler.py ${LAMBDA_TASK_ROOT}/handler.py

RUN python -c "from rembg import new_session; new_session('u2net'); print('✓ u2net model pre-baked')"

CMD ["handler.handler"]