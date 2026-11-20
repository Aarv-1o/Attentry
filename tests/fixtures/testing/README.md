# Route coverage fixtures

One small project per framework, each with routes a test calls, routes no test calls, and
look-alikes that must not count (a URL in a comment, a mocked fetch). Used by
tests/testCoverage.test.ts (docs/tests-plan.md, step 1).

- express-supertest/: Express routes, tests with supertest
- fastapi-testclient/: FastAPI routes, tests with TestClient
- django-client/: Django views, tests with the Django test client
