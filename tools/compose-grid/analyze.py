from PIL import Image
import numpy as np

im = Image.open("preview.png").convert("RGB")
a = np.asarray(im).astype(int)
print("size", im.size)

# background color estimate = most common color
cols, counts = np.unique(a.reshape(-1, 3), axis=0, return_counts=True)
bg = cols[counts.argmax()]
print("bg", bg, "share", counts.max() / counts.sum())

# distance from background
d = np.abs(a - bg).sum(axis=2)
mask = d > 60

rowsum = mask.sum(axis=1)
colsum = mask.sum(axis=0)

def runs(profile, thr):
    out = []
    start = None
    for i, v in enumerate(profile):
        if v > thr and start is None:
            start = i
        elif v <= thr and start is not None:
            out.append((start, i - 1))
            start = None
    if start is not None:
        out.append((start, len(profile) - 1))
    return out

print("row runs (thr=5%):", runs(rowsum, a.shape[1] * 0.05))
print("col runs (thr=5%):", runs(colsum, a.shape[0] * 0.05))
print("row runs (thr=1%):", runs(rowsum, a.shape[1] * 0.01))
print("col runs (thr=1%):", runs(colsum, a.shape[0] * 0.01))

# Print rowsum profile compressed: every row where it changes a lot
print("\nrowsum samples:")
for y in range(0, a.shape[0], 4):
    print(y, int(rowsum[y]))
