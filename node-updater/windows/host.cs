// Separate GUI-subsystem updater host. Never reuses or modifies Codey/tunnel tasks.
using System;
using System.Diagnostics;
using System.IO;
using System.Text;

public static class CodeyUpdaterHost
{
    private static string Quote(string value)
    {
        if (value.IndexOfAny(new char[] { '\0', '\r', '\n', '"' }) >= 0)
            throw new ArgumentException("Invalid updater argument.");
        return "\"" + value + "\"";
    }
    public static int Main(string[] args)
    {
        try
        {
            if (args.Length != 2 || !Path.IsPathRooted(args[0]) || !Path.IsPathRooted(args[1])) return 1;
            string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            string expected = Path.Combine(home, @".config\codey-updater\config.json");
            if (!String.Equals(Path.GetFullPath(args[1]), expected, StringComparison.OrdinalIgnoreCase)) return 1;
            string root = AppDomain.CurrentDomain.BaseDirectory;
            string state = Path.Combine(home, @".local\share\codey-updater");
            string lockFile = Path.Combine(Path.GetDirectoryName(expected), "agent.lock");
            using (var lease = new FileStream(lockFile, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.Read))
            {
                string nonce = Guid.NewGuid().ToString("N");
                byte[] data = Encoding.UTF8.GetBytes("{\"pid\":" + Process.GetCurrentProcess().Id +
                    ",\"nonce\":\"" + nonce + "\"}");
                lease.SetLength(0);
                lease.Write(data, 0, data.Length);
                lease.Flush(true);
                var info = new ProcessStartInfo(args[0], Quote(Path.Combine(root, "agent.mjs")) +
                    " run --config " + Quote(expected));
                info.WorkingDirectory = root;
                info.EnvironmentVariables.Clear();
                foreach (string key in new string[] { "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT",
                    "TEMP", "TMP", "APPDATA", "LOCALAPPDATA", "USERPROFILE", "USERNAME", "OS",
                    "PROCESSOR_ARCHITECTURE", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY" })
                {
                    string value = Environment.GetEnvironmentVariable(key);
                    if (value != null) info.EnvironmentVariables[key] = value;
                }
                info.EnvironmentVariables["HOME"] = home;
                info.EnvironmentVariables["PATH"] = Path.GetDirectoryName(args[0]) + ";" +
                    Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "System32");
                info.EnvironmentVariables["CODEY_UPDATER_HOST_TOKEN"] = nonce;
                // The same reviewed Job Object implementation as the existing
                // service host, compiled into a SEPARATE executable. A crashed
                // host cannot leave a duplicate/orphan updater transaction.
                using (var child = new CodeyBackgroundProcess(info,
                    Path.Combine(state, "agent.stdout.log"), Path.Combine(state, "agent.stderr.log")))
                {
                    child.Process.WaitForExit();
                    child.Drain();
                    return child.Process.ExitCode;
                }
            }
        }
        catch { return 1; } // Never log credentials, private descriptors or arguments.
    }
}
