/** Verify Python runtime behavior without an installed host channel. */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const program = String.raw`
import importlib.util
import pathlib
import sys
import unittest

path = pathlib.Path('src/runtime/python_sdk').resolve()
spec = importlib.util.spec_from_file_location('dsh_mloader_sdk', path / '__init__.py', submodule_search_locations=[str(path)])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
from dsh_mloader_sdk import HostUnavailable
from dsh_mloader_sdk.context import Context, _RuntimeState, state
from dsh_mloader_sdk.runtime import _handle_host_request

class RuntimeStateTest(unittest.TestCase):
    def setUp(self):
        self.state = _RuntimeState()
        self.context = Context(self.state)

    def test_registrations_require_a_channel(self):
        for register in (self.context.tools.register('name', 'description'), self.context.on('event')):
            with self.subTest(register=register), self.assertRaises(HostUnavailable):
                register(lambda *_: None)
        with self.assertRaises(HostUnavailable):
            self.context.effect.register('effect', lambda: None)
        self.assertEqual(self.state.cleanups, [])
        self.assertEqual(self.state.tool_handlers, {})
        self.assertEqual(self.state.event_handlers, {})

    def test_logger_drops_entries_when_the_channel_is_unavailable(self):
        self.context.logger.info('without channel')
        class BrokenChannel:
            def notify(self, *_args):
                raise ValueError('unavailable')
        self.state.channel = BrokenChannel()
        self.context.logger.info('broken channel')

    def test_host_request_requires_a_channel(self):
        previous = state.channel
        state.channel = None
        try:
            with self.assertRaises(HostUnavailable):
                _handle_host_request({'op': 'event'})
        finally:
            state.channel = previous

    def test_event_dispatch_uses_handler_arity(self):
        class RecordingChannel:
            def respond(self, request_id, ok, result=None, error=None):
                self.reply = (request_id, ok, result, error)

        previous_channel, previous_handlers = state.channel, state.event_handlers
        channel = RecordingChannel()
        state.channel = channel
        try:
            for handler, args, expected in (
                (lambda: 'zero', [1, 2], 'zero'),
                (lambda first: first, [1, 2], 1),
                (lambda first, second: [first, second], [1, 2], [1, 2]),
                (lambda *values: list(values), [1, 2], [1, 2]),
            ):
                state.event_handlers = {'event': handler}
                _handle_host_request({'id': 1, 'op': 'event', 'payload': {'event': 'event', 'args': args}})
                self.assertEqual(channel.reply, (1, True, expected, None))
        finally:
            state.channel, state.event_handlers = previous_channel, previous_handlers

    def test_dispose_requires_a_context(self):
        previous_channel, previous_context = state.channel, state.context
        state.channel, state.context = object(), None
        try:
            with self.assertRaises(HostUnavailable):
                _handle_host_request({'op': 'dispose'})
        finally:
            state.channel, state.context = previous_channel, previous_context

unittest.main()
`
const result = spawnSync(process.env.PYTHON ?? 'python3', ['-c', program], { cwd: root, stdio: 'inherit' })
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)
