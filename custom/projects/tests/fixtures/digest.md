# Article Digest -- Proof Points

Made-up sample in upstream's article-digest format. Every name and number is fictional.

---

## FraudShield -- Real-Time Fraud Detection

**Hero metrics:** 99.7% precision, 50ms p99 latency

**Architecture:** Kafka Streams ingestion, then an XGBoost ensemble behind a Redis feature store

**Key decisions:**
- Chose streaming over batch to catch fraud in real time
- Built a custom feature store (Redis-backed, 5ms reads)

**Proof points:**
- Reduced false positives 60% vs the rule-based system
- Handles 10K transactions/second peak load
- Conference talk: "Real-Time ML at Scale"

---

# Publications

## Retrieval Benchmark Study
Kind: publication
- Compared four retrievers on public datasets.

Reviewer notes kept by hand, not part of the copy-paste points.
