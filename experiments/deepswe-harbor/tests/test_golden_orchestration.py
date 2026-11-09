"""DeepSWE byte-identity of the orchestration code (TB design §6.2): fleet command lines and script bodies, driver
paths and environments, check configs and summaries, event and status shapes, export manifest keys, the classifier
grid and the committed plan's launch lists, against the snapshot taken before the Terminal-Bench refactor."""
import golden_orchestration as g


def test_deepswe_orchestration_is_byte_identical_to_the_pre_tb_snapshot():
    want = g.GOLDEN.read_text()
    got = g.canonical(g.capture())
    assert got == want, 'DeepSWE orchestration output changed (diff tests/golden/deepswe_orchestration.json against capture())'
