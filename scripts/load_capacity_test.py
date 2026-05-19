#!/usr/bin/env python3
from __future__ import annotations

import argparse
import asyncio
import json
import math
import os
import random
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx
from google.cloud import firestore

try:
    from google.cloud.firestore_v1.base_query import FieldFilter
except Exception:  # pragma: no cover - compatibility for older google-cloud-firestore
    FieldFilter = None


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def normalize_base_url(value: str) -> str:
    return value.rstrip("/")


def parse_locked_indices(raw: str | None) -> list[int]:
    if not raw:
        return []
    indices: list[int] = []
    for item in raw.split(","):
        item = item.strip()
        if not item:
            continue
        indices.append(int(item))
    return indices


def timestamp_to_iso(value: Any) -> str | None:
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).isoformat()
    return None


def seconds_between(later: Any, earlier: Any) -> float | None:
    if not isinstance(later, datetime) or not isinstance(earlier, datetime):
        return None
    return max(0.0, (later - earlier).total_seconds())


def nearest_rank(values: list[float], percentile: int) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, math.ceil(percentile / 100 * len(ordered)) - 1))
    return ordered[index]


def metric_summary(values: list[float]) -> dict[str, float | int | None]:
    if not values:
        return {"count": 0, "min": None, "max": None, "avg": None, "p50": None, "p95": None, "p99": None}
    return {
        "count": len(values),
        "min": round(min(values), 3),
        "max": round(max(values), 3),
        "avg": round(sum(values) / len(values), 3),
        "p50": round(nearest_rank(values, 50) or 0, 3),
        "p95": round(nearest_rank(values, 95) or 0, 3),
        "p99": round(nearest_rank(values, 99) or 0, 3),
    }


def query_user_jobs(collection, user_id: str):
    if FieldFilter is not None:
        return collection.where(filter=FieldFilter("user_id", "==", user_id)).limit(100).stream()
    return collection.where("user_id", "==", user_id).limit(100).stream()


def fetch_job_payload(db: firestore.Client, job_id: str) -> dict[str, Any]:
    snapshot = db.collection("jobs").document(job_id).get()
    if not snapshot.exists:
        raise RuntimeError(f"Job not found: {job_id}")
    data = snapshot.to_dict() or {}
    payload = data.get("request_payload")
    if not isinstance(payload, dict):
        raise RuntimeError(f"Job {job_id} does not contain request_payload")
    return dict(payload)


def fetch_latest_payload(db: firestore.Client, user_id: str) -> dict[str, Any]:
    latest: dict[str, Any] | None = None
    latest_created_at: datetime | None = None
    for snapshot in query_user_jobs(db.collection("jobs"), user_id):
        data = snapshot.to_dict() or {}
        payload = data.get("request_payload")
        created_at = data.get("created_at")
        if not isinstance(payload, dict) or not isinstance(created_at, datetime):
            continue
        if latest_created_at is None or created_at > latest_created_at:
            latest = dict(payload)
            latest_created_at = created_at
    if latest is None:
        raise RuntimeError(f"No previous job request_payload found for user_id={user_id}")
    return latest


def build_payload(args: argparse.Namespace, db: firestore.Client) -> dict[str, Any]:
    if args.source_job_id:
        payload = fetch_job_payload(db, args.source_job_id)
    elif args.reuse_latest_payload:
        payload = fetch_latest_payload(db, args.user_id)
    else:
        missing = [
            key
            for key, value in {
                "image_uri": args.image_uri,
                "style": args.style,
                "prompt": args.prompt,
            }.items()
            if not value
        ]
        if missing:
            raise RuntimeError(
                "Missing payload values: "
                + ", ".join(missing)
                + ". Provide them or use --reuse-latest-payload / --source-job-id."
            )
        payload = {
            "user_id": args.user_id,
            "image_uri": args.image_uri,
            "style": args.style,
            "prompt": args.prompt,
            "locked_indices": parse_locked_indices(args.locked_indices),
        }

    payload["user_id"] = args.user_id
    if not args.preserve_locked_indices:
        payload["locked_indices"] = []
    payload.setdefault("locked_indices", [])
    return payload


async def post_json(client: httpx.AsyncClient, url: str, token: str, payload: dict[str, Any]) -> httpx.Response:
    return await client.post(url, json=payload, headers={"Authorization": f"Bearer {token}"})


async def get_json(client: httpx.AsyncClient, url: str, token: str) -> httpx.Response:
    return await client.get(url, headers={"Authorization": f"Bearer {token}"})


async def reset_user(client: httpx.AsyncClient, base_url: str, token: str, user_id: str) -> None:
    response = await post_json(client, f"{base_url}/api/v1/jobs/reset", token, {"user_id": user_id})
    if response.status_code != 200:
        raise RuntimeError(f"Reset failed: HTTP {response.status_code} {response.text}")


async def submit_one(
    client: httpx.AsyncClient,
    base_url: str,
    token: str,
    payload: dict[str, Any],
    sequence: int,
    submit_retries: int,
    submit_retry_base_delay: float,
) -> dict[str, Any]:
    wall_started_at = utc_now_iso()
    attempts: list[dict[str, Any]] = []
    max_attempts = max(1, submit_retries + 1)
    for attempt in range(max_attempts):
        started_at = time.monotonic()
        try:
            response = await post_json(client, f"{base_url}/api/v1/jobs/generate", token, payload)
            elapsed = time.monotonic() - started_at
            body = response.json() if response.content else {}
        except Exception as exc:
            body = {"error": str(exc)}
            response = None
            elapsed = time.monotonic() - started_at

        if response is not None and response.status_code == 201:
            return {
                "sequence": sequence,
                "accepted": True,
                "status_code": response.status_code,
                "elapsed_seconds": round(elapsed, 3),
                "submit_started_at": wall_started_at,
                "submit_completed_at": utc_now_iso(),
                "submit_attempts": attempt + 1,
                "retry_attempts": attempts,
                "job_id": body.get("job_id"),
                "dispatch_mode": body.get("dispatch_mode"),
            }

        status_code = response.status_code if response is not None else None
        attempts.append({
            "attempt": attempt + 1,
            "status_code": status_code,
            "error_body": body if isinstance(body, dict) else getattr(response, "text", None),
        })
        if not should_retry_submit(status_code, body) or attempt >= max_attempts - 1:
            return {
                "sequence": sequence,
                "accepted": False,
                "status_code": status_code,
                "elapsed_seconds": round(elapsed, 3),
                "submit_started_at": wall_started_at,
                "submit_completed_at": utc_now_iso(),
                "submit_attempts": attempt + 1,
                "retry_attempts": attempts,
                "error_body": body if isinstance(body, dict) else getattr(response, "text", None),
            }

        delay = submit_retry_base_delay * (2 ** attempt)
        delay += random.uniform(0, delay * 0.25)
        await asyncio.sleep(delay)

    raise RuntimeError("unreachable")


def should_retry_submit(status_code: int | None, body: Any) -> bool:
    if status_code in {409, 429, 500, 502, 503, 504}:
        return True
    if status_code == 400:
        body_text = json.dumps(body, ensure_ascii=False).lower() if isinstance(body, dict) else str(body).lower()
        return "failed to commit transaction" in body_text
    return False


async def submit_jobs(
    client: httpx.AsyncClient,
    args: argparse.Namespace,
    token: str,
    payload: dict[str, Any],
) -> list[dict[str, Any]]:
    submissions: list[dict[str, Any]] = []
    next_sequence = 1
    remaining = args.total_jobs
    wave_number = 1
    while remaining > 0:
        wave_size = min(args.burst_size, remaining)
        print(f"Submitting wave {wave_number}: {wave_size} jobs")
        tasks = [
            submit_one(
                client,
                args.base_url,
                token,
                payload,
                sequence,
                args.submit_retries,
                args.submit_retry_base_delay,
            )
            for sequence in range(next_sequence, next_sequence + wave_size)
        ]
        wave_results = await asyncio.gather(*tasks)
        submissions.extend(wave_results)
        accepted = sum(1 for item in wave_results if item.get("accepted"))
        print(f"Wave {wave_number} accepted {accepted}/{wave_size}")

        remaining -= wave_size
        next_sequence += wave_size
        wave_number += 1
        if remaining > 0 and args.wave_gap_seconds > 0:
            await asyncio.sleep(args.wave_gap_seconds)
    return submissions


async def poll_jobs(
    client: httpx.AsyncClient,
    args: argparse.Namespace,
    token: str,
    job_ids: list[str],
) -> dict[str, dict[str, Any]]:
    pending = set(job_ids)
    statuses: dict[str, dict[str, Any]] = {}
    deadline = time.monotonic() + args.timeout_seconds
    while pending and time.monotonic() < deadline:
        for job_id in list(pending):
            response = await get_json(client, f"{args.base_url}/api/v1/jobs/{job_id}", token)
            if response.status_code != 200:
                statuses[job_id] = {
                    "status": "poll_error",
                    "status_code": response.status_code,
                    "body": response.text,
                    "checked_at": utc_now_iso(),
                }
                pending.remove(job_id)
                continue
            body = response.json()
            status_value = body.get("status")
            statuses[job_id] = {
                "status": status_value,
                "checked_at": utc_now_iso(),
            }
            if status_value in {"completed", "failed"}:
                pending.remove(job_id)

        completed = sum(1 for item in statuses.values() if item.get("status") == "completed")
        failed = sum(1 for item in statuses.values() if item.get("status") == "failed")
        print(f"Poll: completed={completed} failed={failed} pending={len(pending)}")
        if pending:
            await asyncio.sleep(args.poll_seconds)

    for job_id in pending:
        statuses[job_id] = {
            "status": "timeout",
            "checked_at": utc_now_iso(),
        }
    return statuses


def fetch_job_metrics(db: firestore.Client, job_ids: list[str]) -> list[dict[str, Any]]:
    metrics: list[dict[str, Any]] = []
    for job_id in job_ids:
        snapshot = db.collection("jobs").document(job_id).get()
        if not snapshot.exists:
            metrics.append({"job_id": job_id, "exists": False})
            continue
        data = snapshot.to_dict() or {}
        created_at = data.get("created_at")
        published_at = data.get("published_at")
        claimed_at = data.get("worker_last_claimed_at") or data.get("processing_started_at")
        completed_at = data.get("completed_at")
        failed_at = data.get("failed_at")
        terminal_at = completed_at or failed_at
        metrics.append({
            "job_id": job_id,
            "exists": True,
            "status": data.get("status"),
            "dispatch_mode": data.get("dispatch_mode"),
            "worker_attempt": data.get("worker_attempt"),
            "worker_claim_source": data.get("worker_claim_source"),
            "pubsub_delivery_attempt": data.get("pubsub_delivery_attempt"),
            "created_at": timestamp_to_iso(created_at),
            "published_at": timestamp_to_iso(published_at),
            "worker_last_claimed_at": timestamp_to_iso(claimed_at),
            "completed_at": timestamp_to_iso(completed_at),
            "failed_at": timestamp_to_iso(failed_at),
            "publish_latency_seconds": seconds_between(published_at, created_at),
            "queue_wait_seconds": seconds_between(claimed_at, created_at),
            "processing_seconds": seconds_between(terminal_at, claimed_at),
            "total_seconds": seconds_between(terminal_at, created_at),
            "error": data.get("error"),
            "error_type": data.get("error_type"),
        })
    return metrics


def summarize_capacity(job_metrics: list[dict[str, Any]], max_instances: int) -> dict[str, Any]:
    completed = [item for item in job_metrics if item.get("status") == "completed"]
    failed = [item for item in job_metrics if item.get("status") == "failed"]
    queue_waits = [item["queue_wait_seconds"] for item in completed if item.get("queue_wait_seconds") is not None]
    processing = [item["processing_seconds"] for item in completed if item.get("processing_seconds") is not None]
    totals = [item["total_seconds"] for item in completed if item.get("total_seconds") is not None]
    processing_p95 = nearest_rank(processing, 95)
    estimated_jobs_per_min_at_p95 = None
    if processing_p95 and processing_p95 > 0:
        estimated_jobs_per_min_at_p95 = round(max_instances * 60 / processing_p95, 2)
    return {
        "job_count": len(job_metrics),
        "completed_count": len(completed),
        "failed_count": len(failed),
        "queue_wait_seconds": metric_summary(queue_waits),
        "processing_seconds": metric_summary(processing),
        "total_seconds": metric_summary(totals),
        "estimated_jobs_per_min_at_p95": estimated_jobs_per_min_at_p95,
        "max_instances": max_instances,
    }


def write_report(args: argparse.Namespace, report: dict[str, Any]) -> Path:
    report_dir = Path(args.report_dir)
    report_dir.mkdir(parents=True, exist_ok=True)
    path = report_dir / f"capacity_{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')}.json"
    path.write_text(json.dumps(report, indent=2, ensure_ascii=False, default=str) + "\n")
    return path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run StickerLine production load/capacity validation.")
    parser.add_argument("--base-url", default=os.getenv("BASE_URL", "https://stickerline-be-to5rvfgg5a-as.a.run.app"))
    parser.add_argument("--project-id", default=os.getenv("PROJECT_ID", "skitkerline"))
    parser.add_argument("--user-id", default=os.getenv("USER_ID"), required=os.getenv("USER_ID") is None)
    parser.add_argument("--token-env", default="LINE_ACCESS_TOKEN")
    parser.add_argument("--total-jobs", type=int, default=int(os.getenv("TOTAL_JOBS", "20")))
    parser.add_argument("--burst-size", type=int, default=int(os.getenv("BURST_SIZE", "10")))
    parser.add_argument("--wave-gap-seconds", type=float, default=float(os.getenv("WAVE_GAP_SECONDS", "30")))
    parser.add_argument("--poll-seconds", type=float, default=float(os.getenv("POLL_SECONDS", "10")))
    parser.add_argument("--submit-retries", type=int, default=int(os.getenv("SUBMIT_RETRIES", "5")))
    parser.add_argument("--submit-retry-base-delay", type=float, default=float(os.getenv("SUBMIT_RETRY_BASE_DELAY", "0.5")))
    parser.add_argument("--timeout-seconds", type=float, default=float(os.getenv("TIMEOUT_SECONDS", "1200")))
    parser.add_argument("--max-instances", type=int, default=int(os.getenv("MAX_INSTANCES", "200")))
    parser.add_argument("--image-uri", default=os.getenv("IMAGE_URI"))
    parser.add_argument("--style", default=os.getenv("STYLE"))
    parser.add_argument("--prompt", default=os.getenv("PROMPT"))
    parser.add_argument("--locked-indices", default=os.getenv("LOCKED_INDICES"))
    parser.add_argument("--source-job-id", default=os.getenv("SOURCE_JOB_ID"))
    parser.add_argument("--reuse-latest-payload", action="store_true")
    parser.add_argument("--preserve-locked-indices", action="store_true")
    parser.add_argument("--reset-before-run", action="store_true")
    parser.add_argument("--report-dir", default=os.getenv("REPORT_DIR", "Infra/capacity_reports"))
    return parser.parse_args()


async def async_main() -> None:
    args = parse_args()
    args.base_url = normalize_base_url(args.base_url)
    token = os.getenv(args.token_env)
    if not token:
        raise RuntimeError(f"Missing LINE access token. Export it as {args.token_env}.")
    if args.total_jobs <= 0 or args.burst_size <= 0:
        raise RuntimeError("--total-jobs and --burst-size must be positive.")

    db = firestore.Client(project=args.project_id)
    payload = build_payload(args, db)
    timeout = httpx.Timeout(connect=10, read=60, write=30, pool=30)
    async with httpx.AsyncClient(timeout=timeout) as client:
        if args.reset_before_run:
            print("Resetting current sticker cycle before load test")
            await reset_user(client, args.base_url, token, args.user_id)

        started_at = utc_now_iso()
        submissions = await submit_jobs(client, args, token, payload)
        accepted_job_ids = [
            item["job_id"]
            for item in submissions
            if item.get("accepted") and isinstance(item.get("job_id"), str)
        ]
        statuses = await poll_jobs(client, args, token, accepted_job_ids)

    job_metrics = fetch_job_metrics(db, accepted_job_ids)
    summary = summarize_capacity(job_metrics, args.max_instances)
    report = {
        "started_at": started_at,
        "completed_at": utc_now_iso(),
        "config": {
            "base_url": args.base_url,
            "project_id": args.project_id,
            "user_id": args.user_id,
            "total_jobs": args.total_jobs,
            "burst_size": args.burst_size,
            "wave_gap_seconds": args.wave_gap_seconds,
            "submit_retries": args.submit_retries,
            "submit_retry_base_delay": args.submit_retry_base_delay,
            "max_instances": args.max_instances,
            "source_job_id": args.source_job_id,
            "reuse_latest_payload": args.reuse_latest_payload,
            "reset_before_run": args.reset_before_run,
        },
        "payload_without_token": payload,
        "submissions": submissions,
        "poll_statuses": statuses,
        "job_metrics": job_metrics,
        "summary": summary,
    }
    report_path = write_report(args, report)

    print("\nSummary")
    print(json.dumps(summary, indent=2, ensure_ascii=False))
    print(f"\nReport: {report_path}")


def main() -> None:
    try:
        asyncio.run(async_main())
    except KeyboardInterrupt:
        raise SystemExit(130)


if __name__ == "__main__":
    main()
