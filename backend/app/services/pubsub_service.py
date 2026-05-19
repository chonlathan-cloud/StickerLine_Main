import asyncio
import json
import logging

from app.core.config import settings

logger = logging.getLogger(__name__)

GENERATION_JOB_SCHEMA_VERSION = 1


class PubSubPublishError(RuntimeError):
    pass


class PubSubService:
    def __init__(self, project_id: str | None = None, topic_name: str | None = None):
        self.project_id = project_id or settings.PUBSUB_PROJECT_ID or settings.PROJECT_ID
        self.topic_name = topic_name or settings.STICKER_GENERATION_TOPIC
        self._publisher = None
        self._topic_path: str | None = None

    def build_generation_job_message(
        self,
        *,
        job_id: str,
        user_id: str,
        cycle_id: str | None,
    ) -> dict:
        if not job_id:
            raise ValueError("job_id is required for generation Pub/Sub messages.")
        if not user_id:
            raise ValueError("user_id is required for generation Pub/Sub messages.")

        return {
            "schema_version": GENERATION_JOB_SCHEMA_VERSION,
            "job_id": job_id,
            "user_id": user_id,
            "cycle_id": cycle_id,
        }

    async def publish_generation_job(
        self,
        *,
        job_id: str,
        user_id: str,
        cycle_id: str | None,
    ) -> str:
        payload = self.build_generation_job_message(
            job_id=job_id,
            user_id=user_id,
            cycle_id=cycle_id,
        )
        return await asyncio.to_thread(self._publish_payload, payload)

    def _get_publisher(self):
        if self._publisher is not None:
            return self._publisher

        try:
            from google.cloud import pubsub_v1
        except ImportError as exc:
            raise PubSubPublishError(
                "google-cloud-pubsub is not installed. Install backend requirements before using pubsub dispatch."
            ) from exc

        self._publisher = pubsub_v1.PublisherClient()
        self._topic_path = self._publisher.topic_path(self.project_id, self.topic_name)
        return self._publisher

    def _publish_payload(self, payload: dict) -> str:
        publisher = self._get_publisher()
        topic_path = self._topic_path
        if not topic_path:
            raise PubSubPublishError("Pub/Sub topic path was not initialized.")

        data = json.dumps(
            payload,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")

        attributes = {
            "message_type": "sticker_generation_job",
            "schema_version": str(payload["schema_version"]),
            "job_id": str(payload["job_id"]),
            "user_id": str(payload["user_id"]),
        }
        if payload.get("cycle_id"):
            attributes["cycle_id"] = str(payload["cycle_id"])

        try:
            future = publisher.publish(topic_path, data, **attributes)
            message_id = future.result(timeout=settings.PUBSUB_PUBLISH_TIMEOUT_SECONDS)
            logger.info("Published generation job %s to %s as message %s", payload["job_id"], topic_path, message_id)
            return message_id
        except Exception as exc:
            raise PubSubPublishError(f"Failed to publish generation job {payload['job_id']} to {topic_path}") from exc
