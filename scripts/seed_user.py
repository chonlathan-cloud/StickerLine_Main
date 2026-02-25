from datetime import datetime, timezone
from google.cloud import firestore

PROJECT_ID = "skitkerline"  # change if needed


def main() -> None:
    db = firestore.Client(project=PROJECT_ID)

    line_id = "U1234567890"  # TODO: replace with real LINE userId
    display_name = "Local Test"
    picture_url = ""

    user_data = {
        "line_id": line_id,
        "display_name": display_name,
        "picture_url": picture_url,
        "coin_balance": 2,
        "total_spent_thb": 0.0,
        "is_free_trial_used": True,
        "created_at": datetime.now(timezone.utc),
        "updated_at": datetime.now(timezone.utc),
    }

    db.collection("users").document(line_id).set(user_data)
    print("Created user:", line_id)


if __name__ == "__main__":
    main()
