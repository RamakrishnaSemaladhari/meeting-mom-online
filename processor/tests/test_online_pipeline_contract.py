import unittest

from processor.scripts.pipeline.ai_understanding import run_understanding
from processor.scripts.pipeline.validation import validate


class OnlinePipelineContractTests(unittest.TestCase):
    def setUp(self):
        self.original = [
            {"start": 0, "end": 5, "text": "We need to review the renewal backlog."},
            {"start": 6, "end": 12, "text": "Ravi will prepare the renewal report by Friday."},
            {"start": 13, "end": 18, "text": "Let us discuss the unresolved two wheeler cases."},
        ]
        self.translation = [
            {"start": 0, "end": 5, "text": "We need to review the renewal backlog."},
            {"start": 6, "end": 12, "text": "Ravi will prepare the renewal report by Friday."},
            {"start": 13, "end": 18, "text": "Let us discuss the unresolved two wheeler cases."},
        ]

    def test_staged_understanding_keeps_required_outputs(self):
        prompts = []

        def fake_json(prompt):
            prompts.append(prompt)
            return {
                "section_summary": "The meeting reviewed the renewal backlog and discussed unresolved two wheeler cases.",
                "discussion_points": ["Renewal backlog"],
                "decisions": [{
                    "decision": "Review the renewal backlog",
                    "timestamp": "00:00:02",
                    "evidence": "review the renewal backlog"
                }],
                "action_items": [{
                    "action": "Prepare the renewal report",
                    "owner": "Ravi",
                    "deadline": "Friday",
                    "timestamp": "00:00:08",
                    "evidence": "Ravi will prepare the renewal report by Friday"
                }],
                "commitments": [],
                "open_questions": ["Unresolved two wheeler cases"],
                "next_meeting": [],
                "review_flags": []
            }

        def fake_text(prompt):
            return "Complete conversation summary." if "complete conversation" in prompt.lower() else "Executive summary."

        result = run_understanding(
            {"title": "Test Meeting"},
            self.original,
            self.translation,
            fake_json,
            fake_text,
            max_chars=1000,
            model="test-model"
        )

        required = {
            "executive_summary",
            "complete_conversation_summary",
            "discussion_points",
            "decisions",
            "action_items",
            "commitments",
            "open_questions",
            "next_meeting",
            "review_flags",
        }
        self.assertTrue(required.issubset(result.keys()))
        self.assertTrue(prompts)
        self.assertIn("ENGLISH TRANSLATION", prompts[0])

    def test_validation_rejects_unsupported_owner_and_deadline(self):
        ai = {
            "executive_summary": "x",
            "complete_conversation_summary": "x",
            "discussion_points": [],
            "decisions": [],
            "action_items": [{
                "action": "Prepare report",
                "owner": "Unknown Person",
                "deadline": "Next year",
                "timestamp": "00:00:08",
                "evidence": "Ravi will prepare the renewal report by Friday",
                "review_flag": ""
            }],
            "commitments": [],
            "open_questions": [],
            "next_meeting": [],
            "review_flags": []
        }

        validated, report = validate(ai, self.original, self.translation)
        action = validated["action_items"][0]
        self.assertEqual(action["owner"], "Not explicitly assigned")
        self.assertEqual(action["deadline"], "Not explicitly stated")
        self.assertTrue(report["passed"])
        self.assertTrue(report["owners_reset"])
        self.assertTrue(report["deadlines_reset"])


if __name__ == "__main__":
    unittest.main()
