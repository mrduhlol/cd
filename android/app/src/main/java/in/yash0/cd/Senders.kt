package `in`.yash0.cd

import android.content.Context

/** Call once from MainActivity.onCreate, before reading TransferBus or handling shared URIs. */
object Senders {
    @Synchronized fun install(context: Context): SendEngine {
        if (TransferBus.sender === SendEngine.Unavailable) TransferBus.sender = SendEngineImpl(context.applicationContext)
        return TransferBus.sender
    }
}
