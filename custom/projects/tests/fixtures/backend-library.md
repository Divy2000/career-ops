# Projects library

Made-up sample data for tests. Every name, link and number here is fictional.
Unrelated projects come first on purpose: library order must not decide the ranking.

## Portfolio Website -- https://example.org/portfolio
Tags: react, typescript, css
- Built a responsive personal site with React and TypeScript.
- Scored 100 on Lighthouse accessibility.

---

## Habit Tracker iOS App
Tags: swift, swiftui
- Shipped a SwiftUI habit tracker with home-screen widgets.
- Reached 2,000 downloads on the App Store.

---

## Shelf Defender
Tags: unity, c#
- Made a tower-defense game in Unity with C# scripting.
- Designed 12 levels with a custom tile editor.

---

## Regional Sales Dashboard
Tags: tableau, excel
- Built Tableau dashboards for quarterly regional sales reviews.
- Cleaned spreadsheet exports for 40 store managers.

---

## Plant Disease Classifier
Tags: python, pytorch, computer vision
- Trained a PyTorch image model on 20,000 leaf photos in Python.
- Reached 94% accuracy on a held-out set.

---

## Order Event Pipeline

**Hero metrics:** 3,000 events per second with p99 under 80 ms

**Architecture:** Python consumers read order events from Kafka, enrich them, and write to PostgreSQL; the services run on Kubernetes in AWS.

**Key decisions:**
- Event-driven fan-out instead of nightly batch jobs
- Idempotent consumers keyed by event id

**Proof points:**
- Cut order-status latency from 15 minutes to 2 seconds.
- Added tracing and metrics dashboards for every consumer.

---

## Report Job Queue
- Moved slow PDF report generation to background workers with Celery and Redis.
- Added retries with backoff and a dead-letter queue for failed tasks.
- Wrote pytest suites for the task code.

---

## Payments REST API -- https://github.com/example-dev/payments-api
Tags: python, fastapi, postgresql
- Built REST APIs for invoices and refunds with FastAPI and PostgreSQL.
- Made the billing endpoints idempotent and added Redis caching for rate lookups.
- Shipped it in Docker containers with a CI/CD pipeline running pytest.
