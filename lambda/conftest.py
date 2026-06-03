import warnings

def pytest_configure(config):
    # botocore internals still call datetime.utcnow() on Python 3.12+, which is deprecated
    # To suppress and filter the resulting warnings during tests
    config.addinivalue_line(
        "filterwarnings",
        "ignore::DeprecationWarning:botocore",
    )