"""Cloud Run JOBS that ingest SEC's two nightly bulk archives — MONEY-979.

Jobs, not push handlers, and the reason is arithmetic: Pub/Sub push carries a
600-second ack deadline (its maximum), and these files are 1.31 GiB
(``companyfacts.zip``) and 1.45 GiB (``submissions.zip``). A handler that ran
past the deadline would be REDELIVERED while the first copy was still streaming,
so two processes would iterate the same 15,000 members concurrently.

Entry points::

    python -m app.bulk.submissions
    python -m app.bulk.companyfacts
"""
