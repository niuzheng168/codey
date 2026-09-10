"""Sanitized errors shared across installers and service modules."""



class SetupError(RuntimeError):
    pass


class TunnelError(RuntimeError):
    pass


class ServiceError(RuntimeError):
    pass
