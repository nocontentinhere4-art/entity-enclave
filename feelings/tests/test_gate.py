import asyncio, re, pathlib

SRC = pathlib.Path(__file__).resolve().parents[1] / "server.py"


def _gate_class():
    src = SRC.read_text()
    block = src[src.index("class PriorityGate"):src.index("GEN_LOCK = PriorityGate()")]
    ns = {"asyncio": asyncio}
    import heapq
    ns["heapq"] = heapq
    exec(block, ns)
    return ns["PriorityGate"]


def test_high_priority_waiter_gets_the_slot_first():
    PriorityGate = _gate_class()

    async def run():
        gate = PriorityGate()
        order = []
        await gate.acquire(1)  # a long thought holds the slot

        async def worker(name, prio):
            await gate.acquire(prio)
            order.append(name)
            gate.release()

        tasks = [asyncio.create_task(worker("thought-2", 1)), asyncio.create_task(worker("thought-3", 1))]
        await asyncio.sleep(0)
        tasks.append(asyncio.create_task(worker("reply", 0)))
        await asyncio.sleep(0)
        assert gate.waiting == 3
        gate.release()  # the first thought ends: the reply must go next, not the queued thoughts
        await asyncio.gather(*tasks)
        return order

    assert asyncio.run(run()) == ["reply", "thought-2", "thought-3"]
