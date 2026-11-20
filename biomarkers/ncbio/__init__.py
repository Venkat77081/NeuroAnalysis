"""NeuroCapture biomarker analysis (M15, decision 057). Runs at the hospital, next to the connector.

Video → keypoints (MediaPipe, Apache 2.0) → pre-processing → DNE biomarker formulas
(config/biomarker-registry.json). The output is decision support for clinicians, never a diagnosis,
and holds no patient identity.
"""
