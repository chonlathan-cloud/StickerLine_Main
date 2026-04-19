from datetime import datetime, timezone
from google.cloud import firestore

PROJECT_ID = "skitkerline"  # เปลี่ยนถ้าต้องการ

def main():
    db = firestore.Client(project=PROJECT_ID)

    line_id = "U709f85285dbf4153f73216becbaced97"       # ใส่ LINE userId ที่ต้องการ
    display_name = "Pao"
    picture_url = "https://profile.line-scdn.net/0hk5GJ5I2UNBpqMyvgK71KJBpjN3BJQm0IFgUuflk2PXgEBnUeFQUrfw86aSpVU3JLQFUveFc1biNIA28KQzU5OS1QI1kxSCwsHCMkLCJ3LXFLWBJNRRFyGyRobFoUYgY4RhY-Il9PbEsMZDYtQB0mYDpXbncndRoqHWRYTG8BWpkFMUNPR1RyeVowai3e"

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
